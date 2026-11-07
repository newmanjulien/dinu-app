import { ConvexError, v } from 'convex/values';
import { normalizeParagraphBlocks, contractSource } from '../lib/contract/paragraph-migration';
import { assignParagraphRoles } from '../lib/contract/roles';
import { baselineBlock, roleAssignment } from '../lib/contract/source-validators';
import type { BaselineBlock } from '../lib/contract/source-model';
import { validateBaseline } from '../lib/contract/validate-source';
import type { Doc } from './_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import {
	baselineIntegrity,
	canonicalFingerprint,
	readBaseline,
	readBaselineMetadata
} from './baselineStorage';
import { currentPointer } from './templates';
import { historicalRevision } from './playbookItemRevisions';
import { playbookItem } from './playbookValidators';
import schema from './schema';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { MAX_SNAPSHOT_BYTES } from './templateCapacity';

const scope = { companyId: v.id('company'), cursor: v.union(v.string(), v.null()) };
const baselineScope = { companyId: v.id('company'), baselineId: v.id('baselines') };
const progress = v.object({ cursor: v.string(), done: v.boolean(), changed: v.number() });
function requireTransition() {
	if (schema.schemaValidation)
		throw new ConvexError('Paragraph migration requires the reviewed temporary transition schema.');
}

export const inspectBaseline = internalQuery({
	args: baselineScope,
	returns: v.object({
		fingerprint: v.string(),
		sourceFingerprint: v.string(),
		source: v.union(v.literal('docx'), v.literal('seed')),
		originalFileId: v.optional(v.id('_storage')),
		blocks: v.array(baselineBlock)
	}),
	handler: async (ctx, args) => {
		const { baseline, blocks } = await readBaseline(ctx, args.baselineId, args.companyId);
		const normalized = normalizeParagraphBlocks(blocks);
		validateBaseline(normalized);
		return {
			fingerprint: baseline.fingerprint,
			sourceFingerprint: canonicalFingerprint(contractSource(blocks)),
			source: baseline.source,
			...(baseline.source === 'docx' ? { originalFileId: baseline.originalFileId } : {}),
			blocks: normalized
		};
	}
});

async function storeRoles(
	ctx: MutationCtx,
	baseline: Doc<'baselines'>,
	blocks: BaselineBlock[],
	chunks: Awaited<ReturnType<typeof readBaseline>>['chunks'],
	normalized: BaselineBlock[],
	seedItems?: import('convex/values').Infer<typeof playbookItem>[]
) {
	validateBaseline(normalized);
	if (
		canonicalFingerprint(contractSource(blocks)) !==
		canonicalFingerprint(contractSource(normalized))
	)
		throw new ConvexError('Role repair changed contract source.');
	const integrity = baselineIntegrity(normalized);
	if (integrity.fingerprint === baseline.fingerprint) return false;
	let bootstrapKey: string | undefined;
	if (baseline.source === 'seed') {
		if (!seedItems || canonicalFingerprint({ blocks, items: seedItems }) !== baseline.bootstrapKey)
			throw new ConvexError('Supply the original seed items to repair this seed baseline.');
		bootstrapKey = canonicalFingerprint({ blocks: normalized, items: seedItems });
	}
	const next = chunks.map((chunk) => ({
		...chunk,
		blocks: normalized.slice(chunk.firstBlock, chunk.firstBlock + chunk.blocks.length)
	}));
	const chunkReadBytes = next.reduce((sum, chunk) => sum + documentBytes(chunk), 0);

	const update = {
		...integrity,
		chunkReadBytes,
		...(bootstrapKey ? { bootstrapKey } : {})
	};
	await assertStorageCapacity(ctx, {
		documents: next.length + 1,
		bytes: chunkReadBytes + documentBytes({ ...baseline, ...update })
	});
	for (const chunk of next)
		await ctx.db.patch('baselineChunks', chunk._id, { blocks: chunk.blocks });
	await ctx.db.patch('baselines', baseline._id, update);
	// A repair changes the displayed baseline fingerprint. Current authoring is unavailable
	// until the repaired source and complete manifest have been audited/certified together.
	const pointer = await currentPointer(ctx, baseline.companyId);
	if (pointer) {
		const version = await ctx.db.get('templateVersions', pointer.versionId);
		if (version?.baselineId === baseline._id) {
			const authoringGeneration =
				(pointer.authoringGeneration ?? version.authoringGeneration ?? 0) + 1;
			const structuralGeneration =
				(pointer.structuralGeneration ?? version.structuralGeneration ?? 0) + 1;
			await ctx.db.patch('templateVersions', version._id, {
				validation: undefined,
				authoringGeneration,
				structuralGeneration
			});
			await ctx.db.patch('currentTemplate', pointer._id, {
				authoringGeneration,
				structuralGeneration
			});
		}
	}
	return true;
}

/** Reviewed role map; the manifest also contains every prior role for reversal. */
export const repairBaseline = internalMutation({
	args: {
		...baselineScope,
		expectedFingerprint: v.string(),
		sourceFingerprint: v.string(),
		resultFingerprint: v.string(),
		assignments: v.array(roleAssignment),
		seedItems: v.optional(v.array(playbookItem))
	},
	returns: v.object({ fingerprint: v.string(), changed: v.boolean() }),
	handler: async (ctx, args) => {
		requireTransition();
		const { baseline, blocks, chunks } = await readBaseline(ctx, args.baselineId, args.companyId);
		if (canonicalFingerprint(contractSource(blocks)) !== args.sourceFingerprint)
			throw new ConvexError('Contract source changed. Reanalyze this baseline.');
		const normalized = assignParagraphRoles(normalizeParagraphBlocks(blocks), args.assignments);
		const result = baselineIntegrity(normalized);
		if (result.fingerprint !== args.resultFingerprint)
			throw new ConvexError('The reviewed role map does not match its expected result.');
		if (baseline.fingerprint === result.fingerprint)
			return { fingerprint: result.fingerprint, changed: false };
		if (baseline.fingerprint !== args.expectedFingerprint)
			throw new ConvexError('The baseline changed. Review the repair again.');
		const changed = await storeRoles(ctx, baseline, blocks, chunks, normalized, args.seedItems);
		return { fingerprint: result.fingerprint, changed };
	}
});

/** Convert remaining prepared/source records without reinterpreting their classifications. */
export const normalizeBaselines = internalMutation({
	args: { ...scope, seedItems: v.optional(v.array(playbookItem)) },
	returns: progress,
	handler: async (ctx, args) => {
		requireTransition();
		const page = await ctx.db
			.query('baselines')
			.withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
			.paginate({ cursor: args.cursor, numItems: 1 });
		let changed = 0;
		for (const baseline of page.page) {
			if (baseline.state === 'deleting') continue;
			const { blocks, chunks } = await readBaseline(ctx, baseline._id, args.companyId, baseline);
			if (
				await storeRoles(
					ctx,
					baseline,
					blocks,
					chunks,
					normalizeParagraphBlocks(blocks),
					args.seedItems
				)
			)
				changed++;
		}
		return { cursor: page.continueCursor, done: page.isDone, changed };
	}
});

/** Partially deleted/orphan chunks must also satisfy the restored strict schema. */
export const normalizeDetachedChunks = internalMutation({
	args: scope,
	returns: progress,
	handler: async (ctx, args) => {
		requireTransition();
		const page = await ctx.db
			.query('baselineChunks')
			.withIndex('by_companyId_and_baselineId_and_order', (q) => q.eq('companyId', args.companyId))
			.paginate({ cursor: args.cursor, numItems: 1 });
		let changed = 0;
		for (const chunk of page.page) {
			const blocks = normalizeParagraphBlocks(chunk.blocks);
			if (canonicalFingerprint(blocks) === canonicalFingerprint(chunk.blocks)) continue;
			const baseline = await ctx.db.get('baselines', chunk.baselineId);
			if (baseline && (baseline.companyId !== args.companyId || baseline.state !== 'deleting'))
				throw new ConvexError('Normalize live baselines before detached chunks.');
			await assertStorageCapacity(ctx, {
				documents: 1,
				bytes: documentBytes({ ...chunk, blocks })
			});
			await ctx.db.patch('baselineChunks', chunk._id, { blocks });
			changed++;
		}
		return { cursor: page.continueCursor, done: page.isDone, changed };
	}
});

/** Recompute rather than apply deltas: retrying any page is safe. Run after all baselines. */
export const recountVersions = internalMutation({
	args: scope,
	returns: progress,
	handler: async (ctx, args) => {
		requireTransition();
		const page = await ctx.db
			.query('templateVersions')
			.withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
			.paginate({ cursor: args.cursor, numItems: 1 });
		let changed = 0;
		for (const version of page.page) {
			const baseline = await readBaselineMetadata(ctx, version.baselineId, args.companyId);
			let contentReadBytes = baseline.chunkReadBytes;
			const items = [];
			for (let offset = 0; offset < version.items.length; offset += 64) {
				const batch = version.items.slice(offset, offset + 64);
				await assertStorageCapacity(ctx, { queries: batch.length, readDocuments: batch.length });
				const revisions = await Promise.all(
					batch.map((item) => ctx.db.get('playbookItemRevisions', item.revisionId))
				);
				for (const [index, revision] of revisions.entries()) {
					if (
						!revision ||
						revision.companyId !== args.companyId ||
						revision.itemId !== batch[index].itemId
					)
						throw new ConvexError('A captured template revision is unavailable.');
					items.push(historicalRevision(revision));
					contentReadBytes += documentBytes(revision);
				}
			}
			// JSON wrapper {"blocks":...,"items":...} adds 20 bytes to its two arrays.
			const snapshotBytes =
				baseline.blocksJsonBytes + new TextEncoder().encode(JSON.stringify(items)).byteLength + 20;
			if (
				baseline.blockCount !== version.blockCount ||
				items.length !== version.itemCount ||
				snapshotBytes > MAX_SNAPSHOT_BYTES ||
				contentReadBytes + documentBytes(version) + documentBytes(baseline) + 65_536 >
					16 * 1024 * 1024
			)
				throw new ConvexError('The normalized template exceeds its existing capacity guarantee.');
			if (snapshotBytes === version.snapshotBytes && contentReadBytes === version.contentReadBytes)
				continue;
			await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(version) });
			await ctx.db.patch('templateVersions', version._id, { snapshotBytes, contentReadBytes });
			changed++;
		}
		return { cursor: page.continueCursor, done: page.isDone, changed };
	}
});
