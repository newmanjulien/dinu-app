/** Idempotent upgrade of existing email state. This never sends historical mail. */
import { v } from 'convex/values';
import { internalMutation, internalQuery, internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { cancelJob, UNCERTAIN_COOLDOWN } from './emailDeliveries';
import { storeSelections } from './emailSnapshots';
import { snapshotReader } from './templates';
import {
	attributionsFor,
	applicationKey,
	updateAttributions,
	attribution
} from './reviewAttributions';
import type { Id } from './_generated/dataModel';
import type { EmailSelection } from './emailValidators';
import { availableCompany } from './auth';

export const requests = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({ cursor: v.string(), done: v.boolean() }),
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db.query('approvalRequests').paginate({ cursor, numItems: 1 });
		for (const request of page.page) {
			if ('deliveryId' in request) continue;
			const contract = await ctx.db.get('savedContracts', request.contractId);
			if (!contract) {
				await cancelJob(ctx, request.sendJobId);
				await ctx.db.delete('approvalRequests', request._id);
				continue;
			}
			if (!(await availableCompany(ctx, request.companyId)))
				throw new Error('Resume email migration after the company hold is resolved.');
			const job = await ctx.db.system.get('_scheduled_functions', request.sendJobId);
			if (job?.state.kind === 'pending') await cancelJob(ctx, request.sendJobId);
			const status =
				request.status === 'sending'
					? request.dispatchStarted
						? 'uncertain'
						: 'failed'
					: request.status;
			const completedAt = request.completedAt ?? Date.now();
			const deliveryId = await ctx.db.insert('emailDeliveries', {
				companyId: request.companyId,
				contractId: request.contractId,
				recipientEmail: request.recipientEmail,
				event: {
					kind: 'approval',
					contractId: request.contractId,
					requestId: request.id,
					companyName: request.companyName,
					templateVersionId: contract.templateVersionId
				},
				status,
				attempt: 1,
				dispatchStarted: request.dispatchStarted,
				completedAt,
				error: request.error,
				messageId: request.messageId,
				retryable:
					request.retryEligible ||
					(status === 'uncertain' && completedAt + UNCERTAIN_COOLDOWN <= Date.now()),
				...(job?.state.kind === 'inProgress' ? { sendJobId: request.sendJobId } : {})
			});
			const reader = await snapshotReader(ctx, contract);
			const selections: EmailSelection[] = [];
			for (let offset = 0; offset < request.selectedConcessions.length; offset += 16) {
				const entries = await Promise.all(
					request.selectedConcessions.slice(offset, offset + 16).map(async (selection) => {
						const item = await reader.item(selection.itemId);
						const concession = item?.concessions[selection.concessionPosition];
						if (!concession) throw new Error('Legacy approval snapshot is incomplete.');
						return { ...selection, concessionId: concession.id };
					})
				);
				selections.push(...entries);
			}
			await storeSelections(ctx, request.companyId, deliveryId, selections);
			await ctx.db.replace('approvalRequests', request._id, {
				id: request.id,
				companyName: request.companyName,
				recipientEmail: request.recipientEmail,
				companyId: request.companyId,
				contractId: request.contractId,
				requestedAt: request.requestedAt,
				deliveryId
			});
			if (status === 'uncertain' || job?.state.kind === 'inProgress') {
				const recoveryJobId = await ctx.scheduler.runAfter(
					60_000,
					internal.emailDeliveries.recover,
					{ id: deliveryId, attempt: 1 }
				);
				await ctx.db.patch('emailDeliveries', deliveryId, { recoveryJobId });
			}
		}
		return { cursor: page.continueCursor, done: page.isDone };
	}
});
export const notifications = internalMutation({
	args: {},
	returns: v.boolean(),
	handler: async (ctx) => {
		const notice = await ctx.db.query('decisionNotifications').first();
		if (!notice) return true;
		const job = notice.sendJobId
			? await ctx.db.system.get('_scheduled_functions', notice.sendJobId)
			: null;
		if (job?.state.kind === 'pending') await cancelJob(ctx, notice.sendJobId);
		await cancelJob(ctx, notice.recoveryJobId);
		const contract = await ctx.db.get('savedContracts', notice.contractId);
		if (!contract) {
			await ctx.db.delete('decisionNotifications', notice._id);
			return false;
		}
		if (!(await availableCompany(ctx, notice.companyId)))
			throw new Error('Resume email migration after the company hold is resolved.');
		const deliveryId = await ctx.db.insert('emailDeliveries', {
			companyId: notice.companyId,
			contractId: notice.contractId,
			event: {
				kind: 'decision',
				contractId: notice.contractId,
				reviewGeneration: contract?.reviewGeneration ?? 0,
				companyName: notice.companyName,
				templateVersionId: notice.templateVersionId
			},
			status:
				notice.status === 'sending'
					? notice.dispatchStarted
						? 'uncertain'
						: 'skipped'
					: notice.status,
			attempt: 1,
			dispatchStarted: notice.dispatchStarted,
			retryable: false,
			completedAt: notice.completedAt ?? Date.now(),
			recipientEmail: notice.recipientEmail,
			cc: notice.cc,
			recipientAccepted: notice.recipientAccepted,
			rejected: notice.rejected,
			error: notice.error,
			messageId: notice.messageId
		});
		await storeSelections(
			ctx,
			notice.companyId,
			deliveryId,
			notice.decisions.map(({ status, ...decision }) => ({ ...decision, reviewStatus: status }))
		);
		await ctx.db.delete('decisionNotifications', notice._id);
		return false;
	}
});
/** Adopt previously untracked expiry jobs and cancel obsolete email callbacks. */
export const jobs = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({ cursor: v.string(), done: v.boolean() }),
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db.system
			.query('_scheduled_functions')
			.paginate({ cursor, numItems: 100, maximumBytesRead: 1_000_000 });
		for (const job of page.page) {
			if (job.state.kind !== 'pending') continue;
			const name = job.name.replace(/\.js:/, ':');
			if (name === 'approvals:recover' || name === 'companyInvitations:finishDelivery') {
				await ctx.scheduler.cancel(job._id);
				continue;
			}
			if (name !== 'companyInvitations:expire') continue;
			const args: unknown = job.args[0];
			if (
				typeof args !== 'object' ||
				args === null ||
				!('id' in args) ||
				typeof args.id !== 'string' ||
				!('expiresAt' in args) ||
				typeof args.expiresAt !== 'number'
			)
				continue;
			const id = ctx.db.normalizeId('companyInvitations', args.id);
			const invitation = id ? await ctx.db.get('companyInvitations', id) : null;
			if (
				invitation?.status === 'pending' &&
				!invitation.expired &&
				invitation.expiresAt === args.expiresAt &&
				!invitation.expiryJobId
			)
				await ctx.db.patch('companyInvitations', invitation._id, { expiryJobId: job._id });
			else if (invitation?.expiryJobId !== job._id) await ctx.scheduler.cancel(job._id);
		}
		return { cursor: page.continueCursor, done: page.isDone };
	}
});
export const invitations = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({ cursor: v.string(), done: v.boolean() }),
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db.query('companyInvitations').paginate({ cursor, numItems: 50 });
		for (const invitation of page.page) {
			if (invitation.status !== 'pending') continue;
			if (
				!invitation.deliveryId &&
				invitation.deliveryStatus === 'sending' &&
				(invitation.deliveryStartedAt ?? 0) < Date.now() - 11 * 60_000
			)
				await ctx.db.patch('companyInvitations', invitation._id, { deliveryStatus: 'failed' });
			if (!invitation.expiryJobId && invitation.expiresAt > Date.now()) {
				const expiryJobId = await ctx.scheduler.runAt(
					invitation.expiresAt,
					internal.companyInvitations.expire,
					{ id: invitation._id, expiresAt: invitation.expiresAt }
				);
				await ctx.db.patch('companyInvitations', invitation._id, { expiryJobId });
			}
		}
		return { cursor: page.continueCursor, done: page.isDone };
	}
});
export const contracts = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({
		ids: v.array(v.id('savedContracts')),
		cursor: v.string(),
		done: v.boolean()
	}),
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db.query('savedContracts').paginate({ cursor, numItems: 1 });
		return { ids: page.page.map((row) => row._id), cursor: page.continueCursor, done: page.isDone };
	}
});
export const reviewers = internalMutation({
	args: { id: v.id('savedContracts'), offset: v.number() },
	returns: v.boolean(),
	handler: async (ctx, { id, offset }) => {
		const contract = await ctx.db.get('savedContracts', id);
		if (!contract) return true;
		if (!(await availableCompany(ctx, contract.companyId)))
			throw new Error('Resume email migration after the company hold is resolved.');
		const current = await attributionsFor(ctx, id);
		const byItem = new Map(current.entries.map((entry) => [entry.itemId, entry]));
		const reviews = Object.entries(contract.reviews);
		const changes = [];
		for (const [key, review] of reviews.slice(offset, offset + 32)) {
			const itemId = key as Id<'playbookItems'>;
			if (
				review.status === 'pending' ||
				byItem.get(itemId)?.applicationKey === applicationKey(review.concessionId, review.lifecycle)
			)
				continue;
			const receipt = await ctx.db
				.query('concessionDecisions')
				.withIndex('by_contractId_and_itemId_and_lifecycle_and_changed', (q) =>
					q
						.eq('contractId', id)
						.eq('itemId', itemId)
						.eq('lifecycle', review.lifecycle)
						.eq('changed', true)
				)
				.order('desc')
				.first();
			if (receipt?.concessionId === review.concessionId && receipt.status === review.status)
				changes.push(
					attribution(itemId, review.concessionId, review.lifecycle, {
						_id: receipt.adminId,
						name: receipt.adminName
					})
				);
		}
		if (changes.length) await updateAttributions(ctx, contract, contract.reviews, changes);
		return offset + 32 >= reviews.length;
	}
});
export const upgrade = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx): Promise<null> => {
		let cursor: string | null = null;
		do {
			const page: { cursor: string; done: boolean } = await ctx.runMutation(
				internal.emailMigration.requests,
				{ cursor }
			);
			cursor = page.done ? null : page.cursor;
		} while (cursor !== null);
		while (!(await ctx.runMutation(internal.emailMigration.notifications, {}))) {
			/* bounded transactions */
		}
		do {
			const page: { cursor: string; done: boolean } = await ctx.runMutation(
				internal.emailMigration.jobs,
				{ cursor }
			);
			cursor = page.done ? null : page.cursor;
		} while (cursor !== null);
		do {
			const page: { cursor: string; done: boolean } = await ctx.runMutation(
				internal.emailMigration.invitations,
				{ cursor }
			);
			cursor = page.done ? null : page.cursor;
		} while (cursor !== null);
		do {
			const page: { ids: Id<'savedContracts'>[]; cursor: string; done: boolean } =
				await ctx.runQuery(internal.emailMigration.contracts, { cursor });
			for (const id of page.ids)
				for (
					let offset = 0;
					!(await ctx.runMutation(internal.emailMigration.reviewers, { id, offset }));
					offset += 32
				) {
					/* current attribution only */
				}
			cursor = page.done ? null : page.cursor;
		} while (cursor !== null);
		return null;
	}
});
