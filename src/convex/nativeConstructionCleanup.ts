import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { activeJob } from './emailDeliveries';
import { retainedDocument } from './contractRetention';
import { cleanupBudget } from './cleanup';

const runReference = makeFunctionReference<
	'mutation',
	{ receiptId: Id<'operationReceipts'> },
	null
>('nativeConstructionCleanup:run');
/** A receipt owns only one bounded garbage cursor. New obsolete generations join its range. */
export async function queueNativeCleanup(
	ctx: MutationCtx,
	receiptId: Id<'operationReceipts'>,
	through: number
) {
	const row = await ctx.db.get('operationReceipts', receiptId);
	if (!row || through < 0) return;
	const existing = row.nativeCleanup;
	const cleanup = existing
		? { ...existing, through: Math.max(existing.through, through) }
		: {
				generation: 0,
				through,
				phase: 'documents' as const,
				cursor: null,
				offset: 0,
				dueAt: Date.now()
			};
	if (!(await activeJob(ctx, cleanup.jobId)))
		cleanup.jobId = await ctx.scheduler.runAfter(0, runReference, { receiptId });
	cleanup.dueAt = Date.now();
	await ctx.db.patch('operationReceipts', receiptId, { nativeCleanup: cleanup });
}
function owned(
	row: Doc<'operationReceipts'>,
	value: {
		companyId: Id<'company'>;
		contractId: Id<'savedContracts'>;
		stage?: { receiptId: Id<'operationReceipts'>; generation: number };
	}
) {
	if (
		!value.stage ||
		value.stage.receiptId !== row._id ||
		value.stage.generation !== row.nativeCleanup!.generation ||
		value.companyId !== row.companyId ||
		value.contractId !== row.contractId
	)
		throw new Error('Native garbage ownership failed.');
}
export const run = internalMutation({
	args: { receiptId: v.id('operationReceipts') },
	returns: v.null(),
	handler: async (ctx, { receiptId }) => {
		const row = await ctx.db.get('operationReceipts', receiptId);
		if (!row?.nativeCleanup) return null;
		const progress = structuredClone(row.nativeCleanup),
			budget = cleanupBudget(ctx),
			retained = row.nativeResult?.generation === progress.generation ? row.nativeResult : null;
		if (row.state === 'preparing' && row.preparation?.native?.generation === progress.generation)
			throw new Error('Active native generation cannot be drained.');
		row.nativeCleanup = progress;
		if (progress.phase === 'documents') {
			if (progress.documentId) {
				const document = await ctx.db.get('contractDocuments', progress.documentId);
				if (document) {
					owned(row, document);
					if (document._id === retained?.documentId || (await retainedDocument(ctx, document._id)))
						throw new Error('Reachable native document cannot be drained.');
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
						if (progress.phaseDone) {
							progress.phase = 'changes';
							progress.cursor = null;
							progress.phaseDone = false;
						}
					}
				} else {
					progress.documentId = undefined;
					progress.offset = 0;
					if (progress.phaseDone) {
						progress.phase = 'changes';
						progress.cursor = null;
						progress.phaseDone = false;
					}
				}
			} else {
				const page = await ctx.db
					.query('contractDocuments')
					.withIndex('by_stage_receiptId_generation_unit_slot', (q) =>
						q.eq('stage.receiptId', receiptId).eq('stage.generation', progress.generation)
					)
					.paginate({
						cursor: progress.cursor,
						numItems: 1,
						maximumRowsRead: 1,
						maximumBytesRead: 128 * 1024
					});
				for (const document of page.page) {
					owned(row, document);
					if (
						document._id !== retained?.documentId &&
						!(await retainedDocument(ctx, document._id))
					) {
						progress.documentId = document._id;
						progress.offset = 0;
					}
				}
				progress.cursor = page.continueCursor;
				progress.phaseDone = page.isDone;
				if (page.isDone && !progress.documentId) {
					progress.phase = 'changes';
					progress.cursor = null;
					progress.phaseDone = false;
				}
			}
		} else if (progress.phase === 'changes') {
			if (progress.changeId) {
				const change = await ctx.db.get('contractChanges', progress.changeId);
				if (change) {
					owned(row, change);
					if (retained?.changeIds.includes(change._id))
						throw new Error('Adopted native change cannot be drained.');
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
						if (progress.phaseDone) {
							progress.phase = 'decisions';
							progress.cursor = null;
							progress.phaseDone = false;
						}
					}
				} else {
					progress.changeId = undefined;
					if (progress.phaseDone) {
						progress.phase = 'decisions';
						progress.cursor = null;
						progress.phaseDone = false;
					}
				}
			} else {
				const page = await ctx.db
					.query('contractChanges')
					.withIndex('by_stage_receiptId_generation_unit_slot', (q) =>
						q.eq('stage.receiptId', receiptId).eq('stage.generation', progress.generation)
					)
					.paginate({
						cursor: progress.cursor,
						numItems: 1,
						maximumRowsRead: 1,
						maximumBytesRead: 128 * 1024
					});
				for (const change of page.page) {
					owned(row, change);
					if (!retained?.changeIds.includes(change._id)) progress.changeId = change._id;
				}
				progress.cursor = page.continueCursor;
				progress.phaseDone = page.isDone;
				if (page.isDone && !progress.changeId) {
					progress.phase = 'decisions';
					progress.cursor = null;
					progress.phaseDone = false;
				}
			}
		} else if (progress.phase === 'decisions') {
			const page = await ctx.db
				.query('contractChangeDecisions')
				.withIndex('by_stage_receiptId_generation_unit_slot', (q) =>
					q.eq('stage.receiptId', receiptId).eq('stage.generation', progress.generation)
				)
				.paginate({
					cursor: progress.cursor,
					numItems: 4,
					maximumRowsRead: 4,
					maximumBytesRead: 32 * 1024
				});
			for (const decision of page.page) {
				owned(row, decision);
				if (!retained?.decisionIds.includes(decision._id))
					await ctx.db.delete('contractChangeDecisions', decision._id);
			}
			progress.cursor = page.continueCursor;
			if (page.isDone) {
				progress.phase = 'chunks';
				progress.cursor = null;
				progress.offset = 0;
			}
		} else {
			const sections = ['native-plan', 'native-sources', 'native-result'] as const,
				section = sections[progress.offset];
			if (section) {
				const chunks = await ctx.db
					.query('operationReceiptChunks')
					.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
						q
							.eq('receiptId', receiptId)
							.eq('section', section)
							.eq('generation', progress.generation)
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
			} else if (progress.generation < progress.through) {
				progress.generation++;
				progress.phase = 'documents';
				progress.cursor = null;
				progress.offset = 0;
			} else {
				await ctx.db.patch('operationReceipts', receiptId, { nativeCleanup: undefined });
				return null;
			}
		}
		progress.dueAt = Date.now();
		progress.jobId = await ctx.scheduler.runAfter(0, runReference, { receiptId });
		await ctx.db.patch('operationReceipts', receiptId, { nativeCleanup: progress });
		return null;
	}
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
