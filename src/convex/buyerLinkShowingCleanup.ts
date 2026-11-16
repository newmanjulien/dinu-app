import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { CLEANUP_DISCOVERY_PAGE_SIZE, cleanupBudget } from './cleanup';
import { activeJob } from './emailDeliveries';

async function schedule(ctx: MutationCtx, marker: Doc<'buyerLinkShowingCleanups'>) {
	const generation = marker.generation + 1;
	const jobId = await ctx.scheduler.runAfter(0, internal.buyerLinkShowingCleanup.clean, {
		markerId: marker._id,
		generation
	});
	await ctx.db.patch('buyerLinkShowingCleanups', marker._id, { generation, jobId });
}

async function ensureScheduled(ctx: MutationCtx, marker: Doc<'buyerLinkShowingCleanups'>) {
	if (!(await activeJob(ctx, marker.jobId))) await schedule(ctx, marker);
}

/** Membership access is revoked in the caller's transaction; its presentation rows drain later. */
export async function cleanupMembershipShowings(
	ctx: MutationCtx,
	membershipId: Id<'memberships'>,
	companyId: Id<'company'>
) {
	let marker = await ctx.db
		.query('buyerLinkShowingCleanups')
		.withIndex('by_membershipId', (q) => q.eq('membershipId', membershipId))
		.unique();
	if (!marker) {
		const showing = await ctx.db
			.query('buyerLinkBarShowings')
			.withIndex('by_membershipId', (q) => q.eq('membershipId', membershipId))
			.first();
		if (!showing) return;
		const id = await ctx.db.insert('buyerLinkShowingCleanups', {
			membershipId,
			companyId,
			generation: 0
		});
		marker = await ctx.db.get('buyerLinkShowingCleanups', id);
	}
	if (marker) await ensureScheduled(ctx, marker);
}

export const clean = internalMutation({
	args: { markerId: v.id('buyerLinkShowingCleanups'), generation: v.number() },
	returns: v.null(),
	handler: async (ctx, { markerId, generation }) => {
		const marker = await ctx.db.get('buyerLinkShowingCleanups', markerId);
		if (!marker || marker.generation !== generation) return null;
		const budget = cleanupBudget(ctx);
		const drained = await budget.drain(
			'buyerLinkBarShowings',
			ctx.db
				.query('buyerLinkBarShowings')
				.withIndex('by_membershipId', (q) => q.eq('membershipId', marker.membershipId))
		);
		if (drained) await ctx.db.delete('buyerLinkShowingCleanups', markerId);
		else await schedule(ctx, marker);
		return null;
	}
});

export const resumeOne = internalMutation({
	args: { markerId: v.id('buyerLinkShowingCleanups') },
	returns: v.null(),
	handler: async (ctx, { markerId }) => {
		const marker = await ctx.db.get('buyerLinkShowingCleanups', markerId);
		if (marker) await ensureScheduled(ctx, marker);
		return null;
	}
});

export const resume = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('buyerLinkShowingCleanups')
			.withIndex('by_creation_time')
			.paginate({ cursor: cursor ?? null, numItems: CLEANUP_DISCOVERY_PAGE_SIZE });
		for (const marker of result.page) {
			try {
				await ctx.runMutation(internal.buyerLinkShowingCleanup.resumeOne, {
					markerId: marker._id
				});
			} catch (error) {
				console.error('Unable to resume buyer-link showing cleanup', marker._id, error);
			}
		}
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.buyerLinkShowingCleanup.resume, {
				cursor: result.continueCursor
			});
		return null;
	}
});
