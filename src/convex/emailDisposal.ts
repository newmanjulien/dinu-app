import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import {
	activeJob,
	cancelDelivery,
	providerDispatchInProgress,
	RETIRED_DELIVERY_RECHECK
} from './emailDeliveries';
import { cleanupBudget, CLEANUP_DISCOVERY_PAGE_SIZE } from './cleanup';

export type DeliveryRetirement = 'ready' | 'pending' | 'inFlight';

async function schedule(ctx: MutationCtx, delivery: Doc<'emailDeliveries'>, delay = 0) {
	const generation = (delivery.disposal?.generation ?? 0) + 1;
	const jobId = await ctx.scheduler.runAfter(delay, internal.emailDisposal.clean, {
		id: delivery._id,
		generation
	});
	await ctx.db.patch('emailDeliveries', delivery._id, { disposal: { generation, jobId } });
}

async function dispose(
	ctx: MutationCtx,
	delivery: Doc<'emailDeliveries'>
): Promise<DeliveryRetirement> {
	if (providerDispatchInProgress(delivery)) {
		await schedule(ctx, delivery, RETIRED_DELIVERY_RECHECK);
		return 'inFlight';
	}
	const budget = cleanupBudget(ctx);
	const drained = await budget.drain(
		'emailSnapshots',
		ctx.db
			.query('emailSnapshots')
			.withIndex('by_deliveryId_and_order', (q) => q.eq('deliveryId', delivery._id))
	);
	if (drained) return 'ready';
	await schedule(ctx, delivery);
	return 'pending';
}

/** Retire an attempt before removing its parent or replacing its request. */
export async function retireDelivery(
	ctx: MutationCtx,
	delivery: Doc<'emailDeliveries'>
): Promise<DeliveryRetirement> {
	await cancelDelivery(ctx, delivery);
	return dispose(ctx, delivery);
}

/** Retire the old attempt atomically with replacing its request or invitation. */
export async function removeDelivery(ctx: MutationCtx, delivery: Doc<'emailDeliveries'>) {
	const retirement = await retireDelivery(ctx, delivery);
	if (retirement === 'ready') await ctx.db.delete('emailDeliveries', delivery._id);
	return retirement;
}

export const clean = internalMutation({
	args: { id: v.id('emailDeliveries'), generation: v.number() },
	returns: v.null(),
	handler: async (ctx, { id, generation }) => {
		const delivery = await ctx.db.get('emailDeliveries', id);
		if (delivery?.disposal?.generation === generation) {
			if ((await dispose(ctx, delivery)) === 'ready') await ctx.db.delete('emailDeliveries', id);
		}
		return null;
	}
});

export const resumeOne = internalMutation({
	args: { id: v.id('emailDeliveries') },
	returns: v.null(),
	handler: async (ctx, { id }) => {
		const delivery = await ctx.db.get('emailDeliveries', id);
		if (delivery?.disposal && !(await activeJob(ctx, delivery.disposal.jobId)))
			await schedule(ctx, delivery);
		return null;
	}
});

/** Failed workers remain discoverable without reading sent mail or snapshot bodies. */
export const resume = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('emailDeliveries')
			.withIndex('by_disposal_generation', (q) => q.gte('disposal.generation', 1))
			.paginate({ cursor: cursor ?? null, numItems: CLEANUP_DISCOVERY_PAGE_SIZE });
		for (const delivery of result.page) {
			try {
				await ctx.runMutation(internal.emailDisposal.resumeOne, { id: delivery._id });
			} catch {
				console.error('Unable to resume email disposal', delivery._id);
			}
		}
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.emailDisposal.resume, {
				cursor: result.continueCursor
			});
		return null;
	}
});
