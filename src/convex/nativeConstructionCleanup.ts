import { internal } from './_generated/api';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { activeJob } from './emailDeliveries';
import { retainedDocument } from './contractRetention';
import { cleanupBudget } from './cleanup';
import { nativeResultNames, nativeResultOwns } from './nativeStage';

const sections = ['native-plan', 'native-sources', 'native-result'] as const;
type Progress = NonNullable<Doc<'operationReceipts'>['nativeCleanup']>;

/** One bounded owner drains first ranges. A wider range restarts discovery, never skips rows. */
export async function queueNativeCleanup(
	ctx: MutationCtx,
	receiptId: Id<'operationReceipts'>,
	through: number
) {
	const row = await ctx.db.get('operationReceipts', receiptId);
	if (!row || through < 0) return;
	if (!Number.isSafeInteger(through)) throw new Error('Invalid native garbage generation.');
	if (
		row.state === 'preparing' &&
		row.preparation?.native &&
		row.preparation.native.generation <= through
	)
		throw new Error('Active native generation cannot be drained.');
	const existing = row.nativeCleanup;
	const cleanup: Progress =
		existing && through <= existing.through
			? { ...existing }
			: {
					version: existing?.version ?? 0,
					through: Math.max(existing?.through ?? -1, through),
					phase: 'documents',
					offset: 0,
					dueAt: Date.now(),
					...(existing?.jobId ? { jobId: existing.jobId } : {})
				};
	if (!(await activeJob(ctx, cleanup.jobId))) {
		cleanup.version++;
		cleanup.jobId = await ctx.scheduler.runAfter(0, internal.nativeConstructionCleanup.run, {
			receiptId,
			version: cleanup.version
		});
	}
	cleanup.dueAt = Date.now();
	await ctx.db.patch('operationReceipts', receiptId, { nativeCleanup: cleanup });
}

function adopted(
	owner: Doc<'operationReceipts'>,
	table: 'contractDocuments' | 'contractChanges' | 'contractChangeDecisions',
	value: Doc<'contractDocuments'> | Doc<'contractChanges'> | Doc<'contractChangeDecisions'>
) {
	const stage = value.stage;
	if (
		!stage ||
		stage.receiptId !== owner._id ||
		!Number.isSafeInteger(stage.generation) ||
		stage.generation < 0 ||
		stage.generation > owner.nativeCleanup!.through ||
		value.companyId !== owner.companyId ||
		value.contractId !== owner.contractId
	)
		throw new Error('Native garbage ownership failed.');
	if (!nativeResultNames(owner, table, value._id)) return false;
	if (!nativeResultOwns(owner, table, value._id, value))
		throw new Error('Native promotion owner or original result seal changed.');
	return true;
}

/** Exactly one bounded phase unit; promoted/deleted rows leave the actual-owner index. */
async function advance(ctx: MutationCtx, row: Doc<'operationReceipts'>) {
	const progress = structuredClone(row.nativeCleanup!),
		budget = cleanupBudget(ctx);
	if (
		row.state === 'preparing' &&
		row.preparation?.native &&
		row.preparation.native.generation <= progress.through
	)
		throw new Error('Active native generation cannot be drained.');
	if (progress.phase === 'documents') {
		const document = progress.documentId
			? await ctx.db.get('contractDocuments', progress.documentId)
			: await ctx.db
					.query('contractDocuments')
					.withIndex('by_stage_receiptId_generation_unit_slot', (q) =>
						q.eq('stage.receiptId', row._id).lte('stage.generation', progress.through)
					)
					.first();
		if (!document) {
			// Missing historical IDs and interrupted source deletion are harmless.
			progress.documentId = undefined;
			progress.offset = 0;
			// Revisit the first range if a remembered document disappeared.
			if (!row.nativeCleanup!.documentId) progress.phase = 'changes';
		} else if (adopted(row, 'contractDocuments', document)) {
			await ctx.db.patch('contractDocuments', document._id, { stage: undefined });
			progress.documentId = undefined;
			progress.offset = 0;
		} else {
			if (await retainedDocument(ctx, document._id))
				throw new Error('Reachable native document has no matching adoption seal.');
			progress.documentId = document._id;
			for (const id of document.chunkIds.slice(progress.offset, progress.offset + 4)) {
				if (await budget.exhausted()) break;
				const chunk = await ctx.db.get('contractDocumentChunks', id);
				if (chunk) {
					if (chunk.companyId !== row.companyId || chunk.contractId !== row.contractId)
						throw new Error('Native garbage chunk owner changed.');
					await ctx.db.delete('contractDocumentChunks', id);
				}
				progress.offset++;
			}
			if (progress.offset >= document.chunkIds.length) {
				await ctx.db.delete('contractDocuments', document._id);
				progress.documentId = undefined;
				progress.offset = 0;
			}
		}
	} else if (progress.phase === 'changes') {
		const change = progress.changeId
			? await ctx.db.get('contractChanges', progress.changeId)
			: await ctx.db
					.query('contractChanges')
					.withIndex('by_stage_receiptId_generation_unit_slot', (q) =>
						q.eq('stage.receiptId', row._id).lte('stage.generation', progress.through)
					)
					.first();
		if (!change) {
			progress.changeId = undefined;
			if (!row.nativeCleanup!.changeId) progress.phase = 'decisions';
		} else if (adopted(row, 'contractChanges', change)) {
			await ctx.db.patch('contractChanges', change._id, { stage: undefined });
			progress.changeId = undefined;
		} else {
			progress.changeId = change._id;
			const chunks = await ctx.db
				.query('contractChangeContents')
				.withIndex('by_changeId_and_order', (q) => q.eq('changeId', change._id))
				.take(4);
			await budget.drain(
				'contractChangeContents',
				(async function* () {
					for (const chunk of chunks) {
						if (chunk.companyId !== row.companyId || chunk.contractId !== row.contractId)
							throw new Error('Native patch garbage owner changed.');
						yield chunk;
					}
				})()
			);
			if (!chunks.length) {
				await ctx.db.delete('contractChanges', change._id);
				progress.changeId = undefined;
			}
		}
	} else if (progress.phase === 'decisions') {
		const decisions = await ctx.db
			.query('contractChangeDecisions')
			.withIndex('by_stage_receiptId_generation_unit_slot', (q) =>
				q.eq('stage.receiptId', row._id).lte('stage.generation', progress.through)
			)
			.take(4);
		for (const decision of decisions) {
			if (adopted(row, 'contractChangeDecisions', decision))
				await ctx.db.patch('contractChangeDecisions', decision._id, { stage: undefined });
			else await ctx.db.delete('contractChangeDecisions', decision._id);
		}
		if (!decisions.length) {
			progress.phase = 'chunks';
			progress.offset = 0;
		}
	} else {
		const section = sections[progress.offset];
		if (!section) {
			// Keep the original result/seal until the later receipt owner deletes it.
			await ctx.db.patch('operationReceipts', row._id, { nativeCleanup: undefined });
			return;
		}
		const chunks = await ctx.db
			.query('operationReceiptChunks')
			.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
				q.eq('receiptId', row._id).eq('section', section).lte('generation', progress.through)
			)
			.take(8);
		await budget.drain(
			'operationReceiptChunks',
			(async function* () {
				for (const chunk of chunks) {
					if (chunk.companyId !== row.companyId)
						throw new Error('Native receipt garbage owner changed.');
					yield chunk;
				}
			})()
		);
		if (!chunks.length) progress.offset++;
	}
	progress.dueAt = Date.now();
	progress.version++;
	progress.jobId = await ctx.scheduler.runAfter(0, internal.nativeConstructionCleanup.run, {
		receiptId: row._id,
		version: progress.version
	});
	await ctx.db.patch('operationReceipts', row._id, { nativeCleanup: progress });
}

export const run = internalMutation({
	args: { receiptId: v.id('operationReceipts'), version: v.number() },
	returns: v.null(),
	handler: async (ctx, { receiptId, version }) => {
		const row = await ctx.db.get('operationReceipts', receiptId);
		if (row?.nativeCleanup?.version === version) await advance(ctx, row);
		return null;
	}
});

/** Bounded terminal-receipt gate for a later sweeper. Pending work retains the
 * original seal and continues only under native garbage ownership; no receipt GC. */
export async function nativeReceiptDisposal(ctx: MutationCtx, receiptId: Id<'operationReceipts'>) {
	const row = await ctx.db.get('operationReceipts', receiptId);
	if (!row) return 'ready' as const;
	if (row.state === 'preparing') return 'active' as const;
	if (row.nativeCleanup) {
		await queueNativeCleanup(ctx, receiptId, row.nativeCleanup.through);
		return 'pending' as const;
	}
	let through = -1;
	for (const table of [
		'contractDocuments',
		'contractChanges',
		'contractChangeDecisions'
	] as const) {
		const value = await ctx.db
			.query(table)
			.withIndex('by_stage_receiptId_generation_unit_slot', (q) =>
				q.eq('stage.receiptId', receiptId)
			)
			.order('desc')
			.first();
		if (value?.stage) {
			if (!Number.isSafeInteger(value.stage.generation) || value.stage.generation < 0)
				throw new Error('Invalid native stage generation.');
			through = Math.max(through, value.stage.generation);
		}
	}
	for (const section of sections) {
		const chunk = await ctx.db
			.query('operationReceiptChunks')
			.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
				q.eq('receiptId', receiptId).eq('section', section)
			)
			.order('desc')
			.first();
		if (chunk) {
			if (!Number.isSafeInteger(chunk.generation) || chunk.generation < 0)
				throw new Error('Invalid native section generation.');
			through = Math.max(through, chunk.generation);
		}
	}
	if (through < 0) return 'ready' as const;
	await queueNativeCleanup(ctx, receiptId, through);
	return 'pending' as const;
}

export const dispose = internalMutation({
	args: { receiptId: v.id('operationReceipts') },
	returns: v.union(v.literal('ready'), v.literal('pending'), v.literal('active')),
	handler: (ctx, { receiptId }) => nativeReceiptDisposal(ctx, receiptId)
});

/** Recovery is folded into the existing discussion maintenance cron. */
export async function repairNativeCleanup(ctx: MutationCtx) {
	const rows = await ctx.db
		.query('operationReceipts')
		.withIndex('by_nativeCleanup_dueAt', (q) =>
			q.gte('nativeCleanup.dueAt', 0).lte('nativeCleanup.dueAt', Date.now())
		)
		.take(10);
	for (const row of rows)
		if (row.nativeCleanup && !(await activeJob(ctx, row.nativeCleanup.jobId)))
			await queueNativeCleanup(ctx, row._id, row.nativeCleanup.through);
}
