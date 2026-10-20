import { requireMembership, scopedOperation } from './auth';
import { assertAuthoringAvailable, publishTemplate } from './templates';
import { v } from 'convex/values';
import { mutation } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import schema from './schema';
import { playbookItem } from './playbookValidators';
import type { PlaybookItem } from '../lib/playbook/model';
import {
	validatePlaybookItemContent,
	validateNewConcessions,
	validateConcessionUpdate
} from '../lib/playbook/validation';
import { PlaybookValidationError } from '../lib/playbook/validation-error';

async function validate(item: PlaybookItem, saved?: Doc<'playbookItems'>) {
	try {
		validatePlaybookItemContent(item);
		if (saved) validateConcessionUpdate(saved, item);
		else validateNewConcessions(item.concessions);
		return null;
	} catch (error) {
		if (!(error instanceof PlaybookValidationError)) throw error;
		return {
			status: 'rejected' as const,
			message: error.message
		};
	}
}

const conflict = v.object({ status: v.literal('conflict'), item: schema.doc('playbookItems') });
const missing = v.object({ status: v.literal('missing') });

/** One atomic snapshot per operation. Replays acknowledge; they never write again. */
export const savePlaybookItem = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.optional(v.id('playbookItems')),
		item: playbookItem,
		expectedRevision: v.number(),
		operationId: v.string()
	},
	returns: v.union(
		v.object({ status: v.literal('saved'), item: schema.doc('playbookItems') }),
		conflict,
		v.object({ status: v.literal('rejected'), message: v.string() }),
		missing
	),
	handler: async (ctx, { membershipId, id, item, expectedRevision, operationId }) => {
		const profile = await requireMembership(ctx, membershipId);
		if (
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 0 ||
			!/^[0-9a-f-]{36}$/i.test(operationId)
		)
			throw new Error('Invalid save operation');
		if (!id) {
			const receipt = await ctx.db
				.query('creationReceipts')
				.withIndex('by_operationId', (q) =>
					q.eq('operationId', scopedOperation(profile, operationId))
				)
				.unique();
			if (receipt) {
				const current = await ctx.db.get('playbookItems', receipt.itemId);
				if (!current || current.companyId !== profile.companyId)
					return { status: 'missing' as const };
				return {
					status:
						current.lastOperationId === operationId && current.lastOperationCaller === profile._id
							? ('saved' as const)
							: ('conflict' as const),
					item: current
				};
			}
			await assertAuthoringAvailable(ctx, profile.companyId);
			const created = {
				...item,
				companyId: profile.companyId,
				revision: 1,
				lastOperationCaller: profile._id,
				lastOperationId: operationId
			};
			const rejection = await validate(item);
			if (rejection) return rejection;
			const newId = await ctx.db.insert('playbookItems', created);
			await ctx.db.insert('creationReceipts', {
				companyId: profile.companyId,
				operationId: scopedOperation(profile, operationId),
				itemId: newId
			});
			await publishTemplate(ctx, profile.company);
			return { status: 'saved' as const, item: (await ctx.db.get('playbookItems', newId))! };
		}
		const current = await ctx.db.get('playbookItems', id);
		if (!current || current.companyId !== profile.companyId) return { status: 'missing' as const };
		if (current.lastOperationId === operationId && current.lastOperationCaller === profile._id)
			return { status: 'saved' as const, item: current };
		if ((current.revision ?? 0) !== expectedRevision)
			return { status: 'conflict' as const, item: current };
		await assertAuthoringAvailable(ctx, profile.companyId);
		const rejection = await validate(item, current);
		if (rejection) return rejection;
		await ctx.db.replace('playbookItems', id, {
			...item,
			companyId: profile.companyId,
			revision: expectedRevision + 1,
			lastOperationCaller: profile._id,
			lastOperationId: operationId
		});
		await publishTemplate(ctx, profile.company);
		return { status: 'saved' as const, item: (await ctx.db.get('playbookItems', id))! };
	}
});

export const deletePlaybookItem = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('playbookItems'),
		expectedRevision: v.number()
	},
	returns: v.union(v.object({ status: v.literal('deleted') }), conflict),
	handler: async (ctx, { membershipId, id, expectedRevision }) => {
		const profile = await requireMembership(ctx, membershipId);
		const current = await ctx.db.get('playbookItems', id);
		if (current && current.companyId !== profile.companyId)
			throw new Error('This item is unavailable.');
		if (current && (current.revision ?? 0) !== expectedRevision)
			return { status: 'conflict' as const, item: current };
		if (current) {
			await assertAuthoringAvailable(ctx, profile.companyId);
			await ctx.db.delete('playbookItems', id);
			await publishTemplate(ctx, profile.company);
		}
		return { status: 'deleted' as const };
	}
});
