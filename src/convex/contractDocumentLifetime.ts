import { internal } from './_generated/api';
import { ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { activeJob } from './emailDeliveries';
import { cleanupBudget } from './cleanup';

export const DOCUMENT_HOLD_RECHECK = 60 * 60_000;
/** Clock-free ownership; compact history never permits bytes or execution. */
export const outputHoldsDocument = (row: Doc<'contractOutputs'>) => row.format === 'full';

export function contractCleanupMarker(ctx: QueryCtx, contractId: Id<'savedContracts'>) {
	return ctx.db
		.query('contractCleanups')
		.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
		.unique();
}

/** Admission and drain read the same marker/range in the acquiring transaction. */
export async function requireLiveDocumentOwner(
	ctx: QueryCtx,
	scope: { companyId: Id<'company'>; contractId: Id<'savedContracts'> }
) {
	const root = await ctx.db.get('savedContracts', scope.contractId);
	if (
		!root ||
		root.companyId !== scope.companyId ||
		(await contractCleanupMarker(ctx, scope.contractId))
	)
		throw new ConvexError('This contract is unavailable.');
}

/** A full output is the coarse owner, including its transient retirement. No owner scan. */
export async function contractHasDocumentHold(ctx: QueryCtx, marker: Doc<'contractCleanups'>) {
	const owner = await ctx.db
		.query('contractOutputs')
		.withIndex('by_contractId_and_format', (q) =>
			q.eq('contractId', marker.contractId).eq('format', 'full')
		)
		.first();
	if (owner && owner.companyId !== marker.companyId)
		throw new Error('Document hold company changed.');
	return owner !== null && outputHoldsDocument(owner);
}

export async function scheduleContractCleanup(
	ctx: MutationCtx,
	marker: Doc<'contractCleanups'>,
	phase = marker.phase,
	delay = 0
) {
	const generation = marker.generation + 1;
	const jobId = await ctx.scheduler.runAfter(delay, internal.contractCleanup.clean, { markerId: marker._id, generation });
	await ctx.db.patch('contractCleanups', marker._id, {
		phase,
		generation,
		jobId,
		waitingDueAt: phase === 'waitingDocuments' ? Date.now() + DOCUMENT_HOLD_RECHECK : undefined
	});
}

/** Called in the same transaction that replaces/deletes a full output. */
export async function releaseContractDocumentHold(
	ctx: MutationCtx,
	scope: { companyId: Id<'company'>; contractId: Id<'savedContracts'> }
) {
	const marker = await contractCleanupMarker(ctx, scope.contractId);
	if (!marker) return;
	if (marker.companyId !== scope.companyId)
		throw new Error('Document hold release company changed.');
	if (marker.phase === 'waitingDocuments' && !(await contractHasDocumentHold(ctx, marker)))
		await scheduleContractCleanup(ctx, marker);
}

/** One bounded recovery page for the retention maintenance owner. Held markers rotate
 * their discovery deadline; their evidence/byte clocks never change. No continuation here. */
export async function recoverWaitingContractCleanups(
	ctx: MutationCtx,
	now: number,
	budget = cleanupBudget(ctx)
) {
	const markers = await ctx.db
		.query('contractCleanups')
		.withIndex('by_waitingDueAt', (q) => q.gte('waitingDueAt', 0).lte('waitingDueAt', now))
		.take(10);
	let visited = 0;
	for (const marker of markers) {
		if (await budget.exhausted()) break;
		visited++;
		if (marker.phase !== 'waitingDocuments') throw new Error('Invalid document waiting marker.');
		if (await contractHasDocumentHold(ctx, marker))
			await ctx.db.patch('contractCleanups', marker._id, {
				waitingDueAt: now + DOCUMENT_HOLD_RECHECK
			});
		else if (!(await activeJob(ctx, marker.jobId))) await scheduleContractCleanup(ctx, marker);
	}
	return visited;
}
