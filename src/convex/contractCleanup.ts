import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { activeJob, RETIRED_DELIVERY_RECHECK } from './emailDeliveries';
import { retireDelivery } from './emailDisposal';
import { cleanupBudget, CLEANUP_DISCOVERY_PAGE_SIZE } from './cleanup';

async function schedule(
	ctx: MutationCtx,
	marker: Doc<'contractCleanups'>,
	phase = marker.phase,
	delay = 0
) {
	const generation = marker.generation + 1;
	const jobId = await ctx.scheduler.runAfter(delay, internal.contractCleanup.clean, {
		markerId: marker._id,
		generation
	});
	await ctx.db.patch('contractCleanups', marker._id, { phase, generation, jobId });
}

async function ensureScheduled(ctx: MutationCtx, marker: Doc<'contractCleanups'>) {
	if (!(await activeJob(ctx, marker.jobId))) await schedule(ctx, marker);
}

/** Called only after current company access has been verified, in the delete transaction. */
export async function ensureContractCleanup(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	contractId: Id<'savedContracts'>,
	create: boolean
) {
	let marker = await ctx.db
		.query('contractCleanups')
		.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
		.unique();
	if (!marker && create) {
		const id = await ctx.db.insert('contractCleanups', {
			companyId,
			contractId,
			phase: 'decisions',
			generation: 0
		});
		marker = await ctx.db.get('contractCleanups', id);
	}
	// A missing/foreign parent never grants access to another company's marker.
	if (marker?.companyId === companyId) await ensureScheduled(ctx, marker);
}

export const clean = internalMutation({
	args: { markerId: v.id('contractCleanups'), generation: v.number() },
	returns: v.null(),
	handler: async (ctx, { markerId, generation }) => {
		const marker = await ctx.db.get('contractCleanups', markerId);
		if (!marker || marker.generation !== generation) return null;
		const budget = cleanupBudget(ctx);
		const id = marker.contractId;
		let phase = marker.phase;
		let retryDelay = 0;
		if (phase === 'decisions') {
			if (
				await budget.drain(
					'concessionDecisions',
					ctx.db
						.query('concessionDecisions')
						.withIndex('by_contractId', (q) => q.eq('contractId', id))
				)
			)
				phase = 'deliveries';
		}
		if (phase === 'deliveries') {
			const drained = await budget.drain(
				'emailDeliveries',
				ctx.db.query('emailDeliveries').withIndex('by_contractId', (q) => q.eq('contractId', id)),
				{
					beforeDelete: async (delivery) => {
						const retirement = await retireDelivery(ctx, delivery);
						if (retirement === 'ready') return true;
						if (retirement === 'inFlight') retryDelay = RETIRED_DELIVERY_RECHECK;
						return false;
					}
				}
			);
			if (drained) {
				await ctx.db.delete('contractCleanups', markerId);
				return null;
			}
		}
		await schedule(ctx, marker, phase, retryDelay);
		return null;
	}
});

export const resumeOne = internalMutation({
	args: { markerId: v.id('contractCleanups') },
	returns: v.null(),
	handler: async (ctx, { markerId }) => {
		const marker = await ctx.db.get('contractCleanups', markerId);
		if (marker) await ensureScheduled(ctx, marker);
		return null;
	}
});

/** Independently discover cleanup after the parent and its caller have disappeared. */
export const resume = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('contractCleanups')
			.withIndex('by_creation_time')
			.paginate({ cursor: cursor ?? null, numItems: CLEANUP_DISCOVERY_PAGE_SIZE });
		for (const marker of result.page) {
			try {
				await ctx.runMutation(internal.contractCleanup.resumeOne, { markerId: marker._id });
			} catch (error) {
				console.error('Unable to resume contract cleanup', marker._id, error);
			}
		}
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.contractCleanup.resume, {
				cursor: result.continueCursor
			});
		return null;
	}
});
