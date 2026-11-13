import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { availableCompany } from './auth';
import { activeJob } from './emailDeliveries';
import { cleanupBudget } from './cleanup';
import { repairNativeCleanup } from './nativeConstructionCleanup';
import { repairOutputProofCleanup } from './outputProofCleanup';
import { repairOutputPreparations } from './outputReservations';
import { DiscussionIndex } from './discussionIndex';
import {
	admitDiscussionWork,
	DiscussionPreparationRequired,
	discussionMapOwned,
	retireDiscussionMap
} from './discussionMaps';
import {
	maintenanceRun,
	maintenanceRepair,
	maintenanceResumeDue,
	operationResume
} from './discussionOperationReferences';

/** One control owns the chain, including pending original operations and physical garbage. */
export async function scheduleDiscussionMaintenance(ctx: MutationCtx, index: DiscussionIndex) {
	if (await activeJob(ctx, index.control?.jobId)) return undefined;
	const generation = (index.control?.maintenanceGeneration ?? 0) + 1;
	const jobId = await ctx.scheduler.runAfter(0, maintenanceRun, {
		contractId: index.owner.contractId,
		generation
	});
	return { jobId, dueAt: Date.now(), maintenanceGeneration: generation };
}

/** Called after a first flush created the focused control; no business root/directory write. */
export async function ensureDiscussionMaintenance(
	ctx: MutationCtx,
	contractId: Doc<'savedContracts'>['_id']
) {
	const control = await ctx.db
		.query('discussionUnreadControls')
		.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
		.unique();
	if (!control) throw new Error('Discussion maintenance lost its durable control.');
	if (await activeJob(ctx, control.jobId)) return;
	const generation = control.maintenanceGeneration + 1;
	const jobId = await ctx.scheduler.runAfter(0, maintenanceRun, {
		contractId: control.contractId,
		generation
	});
	await ctx.db.patch('discussionUnreadControls', control._id, {
		jobId,
		dueAt: Date.now(),
		maintenanceGeneration: generation
	});
}

async function drainEvent(ctx: MutationCtx, index: DiscussionIndex) {
	const event = index.events[0];
	if (!event) return;
	const rows = await ctx.db
		.query('discussionThreads')
		.withIndex('by_contractId_and_tombstoned_and_indexedDocumentRevision', (q) =>
			q
				.eq('contractId', index.owner.contractId)
				.eq('tombstoned', false)
				.lt('indexedDocumentRevision', event.toRevision)
		)
		.take(10);
	const height = Math.max(
		1,
		...(index.control?.cohorts.map((cohort) => cohort.height) ?? []),
		...(index.control?.supportCohorts.map((cohort) => cohort.height) ?? [])
	);
	for (const thread of rows) {
		try {
			await admitDiscussionWork(ctx, {
				reads: height * 8 + 20,
				queries: height * 8 + 20,
				writes: height * 8 + 20,
				bytes: height * 16_384 + 32_768
			});
		} catch (error) {
			if (error instanceof DiscussionPreparationRequired) break;
			throw error;
		}
		const interval = await index.interval(thread, undefined, event.toRevision);
		if (interval)
			await index.rebase(ctx, thread, event.toRevision, interval, event.map.afterLength);
		else {
			if (thread._id === index.control?.witnessThreadId)
				throw new Error('An invalidated thread remained the exact unread witness.');
			await index.tombstone(ctx, thread);
		}
	}
	const remaining = await ctx.db
		.query('discussionThreads')
		.withIndex('by_contractId_and_tombstoned_and_indexedDocumentRevision', (q) =>
			q
				.eq('contractId', index.owner.contractId)
				.eq('tombstoned', false)
				.lt('indexedDocumentRevision', event.toRevision)
		)
		.first();
	if (!remaining) {
		// Replies, receipts and large map chunks cannot occupy a logical event slot.
		await ctx.db.delete('discussionInvalidations', event._id);
		await retireDiscussionMap(ctx, index.owner, event.map);
		index.events.shift();
		index.advanceGeneration();
		index.advanceStorageGeneration();
	}
}

async function drainChildren(ctx: MutationCtx, index: DiscussionIndex) {
	const budget = cleanupBudget(ctx);
	const thread = await ctx.db
		.query('discussionThreads')
		.withIndex('by_contractId_and_tombstoned_and_cleanupDueAt', (q) =>
			q.eq('contractId', index.owner.contractId).eq('tombstoned', true).gte('cleanupDueAt', 0)
		)
		.first();
	if (thread && !(await budget.exhausted())) {
		if (!index.owned(thread)) throw new Error('Discussion child-cleanup ownership is invalid.');
		const table = thread.cleanupPhase === 'messages' ? 'discussionMessages' : 'discussionReceipts';
		if (thread.cleanupPhase !== 'messages' && thread.cleanupPhase !== 'receipts')
			throw new Error('Discussion child-cleanup phase is invalid.');
		const query = () =>
			table === 'discussionMessages'
				? ctx.db
						.query('discussionMessages')
						.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', thread._id))
				: ctx.db
						.query('discussionReceipts')
						.withIndex('by_threadId', (q) => q.eq('threadId', thread._id));
		const rows = await query().take(20);
		for (const row of rows) {
			if (row.companyId !== index.owner.companyId || row.contractId !== index.owner.contractId)
				throw new Error('Discussion child ownership is invalid.');
		}
		// The query is front-drained: deleting children never invalidates a pagination cursor.
		async function* boundedRows() {
			yield* rows;
		}
		const drained = await budget.drain(table, boundedRows());
		const more = drained ? await query().first() : true;
		const phase = more
			? thread.cleanupPhase
			: thread.cleanupPhase === 'messages'
				? 'receipts'
				: 'done';
		await ctx.db.patch('discussionThreads', thread._id, {
			cleanupPhase: phase,
			cleanupDueAt:
				phase === 'done' ? undefined : Math.max(Date.now(), (thread.cleanupDueAt ?? 0) + 1)
		});
		// Keep the permanent tombstone after its children drain, including same-revision create retries.
	}
	if (await budget.exhausted()) return;
	const marker = await ctx.db
		.query('discussionTransitionMapChunks')
		.withIndex('by_contractId_and_garbage', (q) =>
			q.eq('contractId', index.owner.contractId).eq('garbage', true)
		)
		.first();
	if (!marker) return;
	if (marker.companyId !== index.owner.companyId)
		throw new Error('Discussion map garbage ownership is invalid.');
	// Acquisition and deletion read the same exact owner ranges in this mutation.
	// Clear a stale marker so a live shared map cannot starve unrelated garbage.
	if (await discussionMapOwned(ctx, index.owner, marker.mapKey)) {
		await ctx.db.patch('discussionTransitionMapChunks', marker._id, { garbage: undefined });
		return;
	}
	const query = () =>
		ctx.db
			.query('discussionTransitionMapChunks')
			.withIndex('by_mapKey_and_firstBefore', (q) => q.eq('mapKey', marker.mapKey));
	const rows = (await query().take(21)).filter((row) => row._id !== marker._id);
	async function* boundedChunks() {
		yield* rows;
	}
	const drained = await budget.drain('discussionTransitionMapChunks', boundedChunks(), {
		beforeDelete: async (row) => {
			if (row.companyId !== index.owner.companyId || row.contractId !== index.owner.contractId)
				throw new Error('Discussion map garbage child ownership is invalid.');
		}
	});
	if (drained && (await query().take(2)).every((row) => row._id === marker._id))
		await ctx.db.delete('discussionTransitionMapChunks', marker._id);
}

export const run = internalMutation({
	args: { contractId: v.id('savedContracts'), generation: v.number() },
	returns: v.null(),
	handler: async (ctx, { contractId, generation }) => {
		const control = await ctx.db
			.query('discussionUnreadControls')
			.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
			.unique();
		if (!control || control.maintenanceGeneration !== generation) return null;
		const controlId = control._id;
		const root = await ctx.db.get('savedContracts', control.contractId);
		const [nativePending, emailPending] = await Promise.all([
			ctx.db
				.query('operationReceipts')
				.withIndex('by_contractId_and_state_and_preparation_dueAt', (q) =>
					q
						.eq('contractId', control.contractId)
						.eq('state', 'preparing')
						.gte('preparation.dueAt', 0)
				)
				.first(),
			ctx.db
				.query('operationReceipts')
				.withIndex('by_contractId_and_state_and_emailPreparation_dueAt', (q) =>
					q
						.eq('contractId', control.contractId)
						.eq('state', 'preparing')
						.gte('emailPreparation.dueAt', 0)
				)
				.first()
		]);
		const pending = !nativePending
			? emailPending
			: !emailPending
				? nativePending
				: nativePending.preparation!.dueAt <= emailPending.emailPreparation!.dueAt
					? nativePending
					: emailPending;
		let work = Boolean(pending);
		let physical: DiscussionIndex | undefined;
		if (
			root &&
			root.companyId === control.companyId &&
			(await availableCompany(ctx, root.companyId))
		) {
			const index = await DiscussionIndex.open(ctx, root);
			physical = index;
			await drainEvent(ctx, index);
			// Alternate a reserved physical turn with event -> preparation -> physical.
			// A very large native preparation cannot starve another thread's child cleanup.
			if (control.cleanupTurn) await drainChildren(ctx, index);
			const child = await ctx.db
				.query('discussionThreads')
				.withIndex('by_contractId_and_tombstoned_and_cleanupDueAt', (q) =>
					q.eq('contractId', root._id).eq('tombstoned', true).gte('cleanupDueAt', 0)
				)
				.first();
			const garbage = await ctx.db
				.query('discussionTransitionMapChunks')
				.withIndex('by_contractId_and_garbage', (q) =>
					q.eq('contractId', root._id).eq('garbage', true)
				)
				.first();
			work ||= Boolean(index.events.length || child || garbage);
			const next = generation + 1;
			const jobId = work
				? await ctx.scheduler.runAfter(
						['sources', 'constructing'].includes(pending?.preparation?.native?.phase ?? '') &&
							!index.events.length
							? 1000
							: 0,
						maintenanceRun,
						{ contractId, generation: next }
					)
				: undefined;
			await index.flush(
				ctx,
				control.witnessThreadId,
				{
					jobId,
					dueAt: work ? Date.now() : undefined,
					maintenanceGeneration: next,
					cleanupTurn: !control.cleanupTurn
				},
				false
			);
		} else {
			const next = generation + 1;
			const jobId = work
				? await ctx.scheduler.runAfter(0, maintenanceRun, { contractId, generation: next })
				: undefined;
			await ctx.db.patch('discussionUnreadControls', controlId, {
				jobId,
				dueAt: work ? Date.now() : undefined,
				maintenanceGeneration: next
			});
		}
		// Nested executor owns its native business commit; no stale control write follows it.
		if (pending) await ctx.runMutation(operationResume, { receiptId: pending._id });
		if (physical && !control.cleanupTurn) await drainChildren(ctx, physical);
		return null;
	}
});

export const repair = internalMutation({
	args: { controlId: v.id('discussionUnreadControls') },
	returns: v.null(),
	handler: async (ctx, { controlId }) => {
		const control = await ctx.db.get('discussionUnreadControls', controlId);
		if (control?.dueAt !== undefined && !(await activeJob(ctx, control.jobId)))
			await ensureDiscussionMaintenance(ctx, control.contractId);
		return null;
	}
});
export const resumeDue = internalMutation({
	args: { cursor: v.optional(v.string()) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		if (!cursor) {
			await repairNativeCleanup(ctx);
			await repairOutputProofCleanup(ctx);
			await repairOutputPreparations(ctx);
		}
		const page = await ctx.db
			.query('discussionUnreadControls')
			.withIndex('by_dueAt', (q) => q.gte('dueAt', 0).lte('dueAt', Date.now()))
			.paginate({
				cursor: cursor ?? null,
				numItems: 10,
				maximumRowsRead: 10,
				maximumBytesRead: 100_000
			});
		for (const row of page.page) await ctx.runMutation(maintenanceRepair, { controlId: row._id });
		if (!page.isDone)
			await ctx.scheduler.runAfter(0, maintenanceResumeDue, { cursor: page.continueCursor });
		return null;
	}
});
