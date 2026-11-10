import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation, type MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { resolve, seller } from './buyerLinks';
import { deviceCategory } from './buyerActivityValidators';
import { contractReader } from './contractReader';
import { assertStorageCapacity } from './storageCapacity';
import { ACTIVITY_RETENTION } from '../lib/buyer/tracking';
import { activityRequest, validActivity } from '../lib/buyer/activity-transport';
import { consumeActivityQuota } from './buyerActivityQuota';
import { cleanupBudget } from './cleanup';

const MAX_OPENING_EVENTS = 1000;
const recordResult = v.union(
	v.object({ kind: v.literal('recorded'), expiresAt: v.optional(v.number()) }),
	v.object({ kind: v.literal('unavailable') }),
	v.object({ kind: v.literal('limited'), retryAfter: v.number() })
);

async function allocateVisitorNumber(
	ctx: MutationCtx,
	contract: Pick<Doc<'savedContracts'>, '_id' | 'companyId'>
) {
	const counter = await ctx.db
		.query('buyerActivityCounters')
		.withIndex('by_contractId', (q) => q.eq('contractId', contract._id))
		.unique();
	const number = counter?.nextVisitorNumber ?? 1;
	if (counter)
		await ctx.db.patch('buyerActivityCounters', counter._id, { nextVisitorNumber: number + 1 });
	else
		await ctx.db.insert('buyerActivityCounters', {
			companyId: contract.companyId,
			contractId: contract._id,
			nextVisitorNumber: number + 1
		});
	return number;
}
function changed(): never {
	throw new ConvexError('Activity changed during delivery.');
}

/** Secret intake only. Deduplication and summaries commit in one transaction. */
export const record = internalMutation({
	args: { request: activityRequest, device: v.optional(deviceCategory) },
	returns: recordResult,
	handler: async (ctx, { request, device }) => {
		if (!validActivity(request)) throw new ConvexError('Invalid activity.');
		const resolved = await resolve(ctx, request.token);
		if (!resolved) return { kind: 'unavailable' as const };
		const { link, contract, state } = resolved;
		const now = Date.now();
		const opening = await ctx.db
			.query('buyerActivityOpenings')
			.withIndex('by_contractId_and_openingId', (q) =>
				q.eq('contractId', contract._id).eq('openingId', request.openingId)
			)
			.unique();
		if (opening && (opening.browserId !== request.browserId || opening.linkId !== link._id))
			changed();
		if (opening && opening.expiresAt <= now) return { kind: 'unavailable' as const };
		if (request.kind === 'open') {
			if (opening) return { kind: 'recorded' as const, expiresAt: opening.expiresAt };
			const retryAfter = await consumeActivityQuota(ctx, link, request.browserId);
			if (retryAfter !== null) return { kind: 'limited' as const, retryAfter };
			const previous = await ctx.db
				.query('buyerActivityOpenings')
				.withIndex('by_contractId_and_browserId_and_acceptedAt', (q) =>
					q.eq('contractId', contract._id).eq('browserId', request.browserId)
				)
				.order('desc')
				.first();
			const returning = Boolean(previous && previous.expiresAt > now);
			await assertStorageCapacity(ctx, { documents: 2, bytes: 4000 });
			const visitorNumber =
				returning && previous ? previous.visitorNumber : await allocateVisitorNumber(ctx, contract);
			const expiresAt = now + ACTIVITY_RETENTION;
			await ctx.db.insert('buyerActivityOpenings', {
				companyId: link.companyId,
				contractId: contract._id,
				linkId: link._id,
				browserId: request.browserId,
				openingId: request.openingId,
				acceptedAt: now,
				expiresAt,
				visitorNumber,
				returning,
				clauseCount: 0,
				eventCount: 0,
				device
			});
			return { kind: 'recorded' as const, expiresAt };
		}
		if (!opening) return { kind: 'unavailable' as const };
		const receipt = await ctx.db
			.query('buyerActivityReceipts')
			.withIndex('by_contractId_and_eventId', (q) =>
				q.eq('contractId', contract._id).eq('eventId', request.eventId)
			)
			.unique();
		if (receipt) {
			if (
				receipt.openingId !== opening._id ||
				receipt.sequence !== request.sequence ||
				receipt.itemId !== request.itemId
			)
				changed();
			return { kind: 'recorded' as const };
		}
		const retryAfter = await consumeActivityQuota(ctx, link, request.browserId);
		if (retryAfter !== null) return { kind: 'limited' as const, retryAfter };
		// Only a clause on the currently accessible publication may be reported.
		const itemId = ctx.db.normalizeId('playbookItems', request.itemId);
		if (!itemId) return { kind: 'unavailable' as const };
		const item = await (await contractReader(ctx, contract)).buyerExplanation(itemId);
		if (!item?.explanation.trim()) return { kind: 'unavailable' as const };
		if (opening.eventCount >= MAX_OPENING_EVENTS)
			return { kind: 'limited' as const, retryAfter: 60 };
		const previous = await ctx.db
			.query('buyerActivityReceipts')
			.withIndex('by_openingId_and_itemId', (q) =>
				q.eq('openingId', opening._id).eq('itemId', request.itemId)
			)
			.first();
		await assertStorageCapacity(ctx, { documents: 2, bytes: 4000 });
		const child = {
			companyId: link.companyId,
			contractId: contract._id,
			openingId: opening._id,
			expiresAt: opening.expiresAt
		};
		await ctx.db.insert('buyerActivityReceipts', {
			...child,
			eventId: request.eventId,
			itemId: request.itemId,
			sequence: request.sequence
		});
		await ctx.db.patch('buyerActivityOpenings', opening._id, {
			clauseCount: opening.clauseCount + (previous ? 0 : 1),
			eventCount: opening.eventCount + 1,
			lastClauseAt: now
		});
		return { kind: 'recorded' as const };
	}
});

/** A mutation supplies a trusted clock without a stale wall-clock-dependent query. */
export const recent = mutation({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts') },
	returns: v.array(
		v.object({
			id: v.string(),
			at: v.number(),
			expiresAt: v.number(),
			visitorNumber: v.number(),
			type: v.union(v.literal('link_opened'), v.literal('clause_opened')),
			returning: v.boolean(),
			clauseCount: v.number(),
			device: v.optional(deviceCategory)
		})
	),
	handler: async (ctx, args) => {
		await seller(ctx, args);
		const openings = await ctx.db
			.query('buyerActivityOpenings')
			.withIndex('by_contractId_and_expiresAt', (q) =>
				q.eq('contractId', args.id).gt('expiresAt', Date.now())
			)
			.order('desc')
			.take(10);
		const rows = [];
		for (const opening of openings) {
			const shared = {
				visitorNumber: opening.visitorNumber,
				returning: opening.returning,
				clauseCount: opening.clauseCount,
				expiresAt: opening.expiresAt,
				device: opening.device
			};
			rows.push({
				...shared,
				id: `${opening._id}:opened`,
				at: opening.acceptedAt,
				type: 'link_opened' as const
			});
			if (opening.lastClauseAt !== undefined)
				rows.push({
					...shared,
					id: `${opening._id}:clauses`,
					at: opening.lastClauseAt,
					type: 'clause_opened' as const
				});
		}
		return rows.sort((a, b) => b.at - a.at);
	}
});

/** Bounded retirement of expired activity. Reads and writes also enforce expiry. */
export const expire = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		const budget = cleanupBudget(ctx);
		for (const table of [
			'buyerActivityReceipts',
			'buyerActivityClauses',
			'buyerActivityOpenings'
		] as const) {
			if (
				!(await budget.drain(
					table,
					ctx.db.query(table).withIndex('by_expiresAt', (q) => q.lte('expiresAt', now))
				))
			) {
				await ctx.scheduler.runAfter(0, internal.buyerActivity.expire, {});
				break;
			}
		}
		return null;
	}
});

/** Explicit retirement of older raw activity history. */
export const retireLegacy = internalMutation({
	args: { companyId: v.id('company'), writerStoppedAt: v.number() },
	returns: v.object({ done: v.boolean(), removed: v.number() }),
	handler: async (ctx, { companyId, writerStoppedAt }) => {
		if (!Number.isFinite(writerStoppedAt) || writerStoppedAt > Date.now())
			throw new ConvexError('Confirm the legacy writer has stopped.');
		const budget = cleanupBudget(ctx);
		let removed = 0;
		for (const table of [
			'buyerLinkOpens',
			'buyerVisits',
			'buyerLinkStats',
			'buyerLinkBrowsers'
		] as const) {
			if (
				!(await budget.drain(
					table,
					ctx.db.query(table).withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
					{
						afterDelete: async () => {
							removed++;
						}
					}
				))
			)
				return { done: false, removed };
		}
		return { done: true, removed };
	}
});
