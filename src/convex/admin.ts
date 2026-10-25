import { requirePermission, scopedOperation } from './auth';
import { assertAuthoringAvailable, publishTemplate } from './templates';
import { createAuthoringItem, storeItemRevision } from './playbookItemRevisions';
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
import { documentBytes, publicationCapacity } from './templateCapacity';
import { PlaybookValidationError } from '../lib/playbook/validation-error';

function validate(item: PlaybookItem, saved?: Doc<'playbookItems'>) {
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
		const profile = await requirePermission(ctx, 'manageTemplate', membershipId);
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
			const rejection = validate(item);
			if (rejection) return rejection;
			const captured = await assertAuthoringAvailable(ctx, profile.companyId);
			const created = {
				...item,
				companyId: profile.companyId,
				lastOperationCaller: profile._id,
				lastOperationId: operationId
			};
			const next = await createAuthoringItem(ctx, created);
			const newId = next._id;
			const createdReceipt = {
				companyId: profile.companyId,
				operationId: scopedOperation(profile, operationId),
				itemId: newId
			};
			await publicationCapacity(ctx, { documents: 1, bytes: documentBytes(createdReceipt) });
			await ctx.db.insert('creationReceipts', createdReceipt);
			captured.items.push(next);
			await publishTemplate(ctx, profile.companyId, captured);
			return { status: 'saved' as const, item: next };
		}
		const current = await ctx.db.get('playbookItems', id);
		if (!current || current.companyId !== profile.companyId) return { status: 'missing' as const };
		if (current.lastOperationId === operationId && current.lastOperationCaller === profile._id)
			return { status: 'saved' as const, item: current };
		if (current.revision !== expectedRevision)
			return { status: 'conflict' as const, item: current };
		const rejection = validate(item, current);
		if (rejection) return rejection;
		const captured = await assertAuthoringAvailable(ctx, profile.companyId);
		const proposed = {
			_id: current._id,
			_creationTime: current._creationTime,
			...item,
			companyId: profile.companyId,
			revision: expectedRevision + 1,
			lastOperationCaller: profile._id,
			lastOperationId: operationId
		};
		const publishedRevisionId = await storeItemRevision(ctx, proposed);
		const next = { ...proposed, publishedRevisionId };
		const { _id, _creationTime, ...stored } = next;
		await publicationCapacity(ctx, { documents: 1, bytes: documentBytes(next) });
		await ctx.db.replace('playbookItems', id, stored);
		captured.items = captured.items.map((saved) => (saved._id === id ? next : saved));
		await publishTemplate(ctx, profile.companyId, captured);
		return { status: 'saved' as const, item: next };
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
		const profile = await requirePermission(ctx, 'manageTemplate', membershipId);
		const current = await ctx.db.get('playbookItems', id);
		if (current && current.companyId !== profile.companyId)
			throw new Error('This item is unavailable.');
		if (current && current.revision !== expectedRevision)
			return { status: 'conflict' as const, item: current };
		if (current) {
			const captured = await assertAuthoringAvailable(ctx, profile.companyId);
			await publicationCapacity(ctx, { documents: 1 });
			await ctx.db.delete('playbookItems', id);
			captured.items = captured.items.filter((saved) => saved._id !== id);
			await publishTemplate(ctx, profile.companyId, captured);
		}
		return { status: 'deleted' as const };
	}
});
