import { ConvexError, v } from 'convex/values';
import { normalizeParagraphBlocks, documentSource } from '../lib/document/paragraph-migration';
import { assignParagraphRoles } from '../lib/document/roles';
import { sourceBlock, roleAssignment } from '../lib/document/source-validators';
import type { SourceBlock } from '../lib/document/source-model';
import { validateDocumentSource } from '../lib/document/validate-source';
import type { Doc } from './_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import {
	templateSourceIntegrity,
	canonicalFingerprint,
	readTemplateSource,
	readTemplateSourceMetadata
} from './templateSourceStorage';
import { currentPointer } from './templates';
import { historicalRevision } from './playbookItemRevisions';
import { playbookItem } from './playbookValidators';
import schema from './schema';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { MAX_SNAPSHOT_BYTES } from './templateCapacity';

const scope = { companyId: v.id('company'), cursor: v.union(v.string(), v.null()) };
const templateSourceScope = {
	companyId: v.id('company'),
	templateSourceId: v.id('templateSources')
};
const progress = v.object({ cursor: v.string(), done: v.boolean(), changed: v.number() });
function requireTransition() {
	if (schema.schemaValidation)
		throw new ConvexError('Paragraph migration requires the reviewed temporary transition schema.');
}

export const inspectSource = internalQuery({
	args: templateSourceScope,
	returns: v.object({
		fingerprint: v.string(),
		sourceFingerprint: v.string(),
		source: v.union(v.literal('docx'), v.literal('seed')),
		originalFileId: v.optional(v.id('_storage')),
		blocks: v.array(sourceBlock)
	}),
	handler: async (ctx, args) => {
		const { templateSource, blocks } = await readTemplateSource(
			ctx,
			args.templateSourceId,
			args.companyId
		);
		const normalized = normalizeParagraphBlocks(blocks);
		validateDocumentSource(normalized);
		return {
			fingerprint: templateSource.fingerprint,
			sourceFingerprint: canonicalFingerprint(documentSource(blocks)),
			source: templateSource.source,
			...(templateSource.source === 'docx'
				? { originalFileId: templateSource.originalFileId }
				: {}),
			blocks: normalized
		};
	}
});

async function storeRoles(
	ctx: MutationCtx,
	templateSource: Doc<'templateSources'>,
	blocks: SourceBlock[],
	chunks: Awaited<ReturnType<typeof readTemplateSource>>['chunks'],
	normalized: SourceBlock[],
	seedItems?: import('convex/values').Infer<typeof playbookItem>[]
) {
	validateDocumentSource(normalized);
	if (
		canonicalFingerprint(documentSource(blocks)) !==
		canonicalFingerprint(documentSource(normalized))
	)
		throw new ConvexError('Role repair changed document source.');
	const integrity = templateSourceIntegrity(normalized);
	if (integrity.fingerprint === templateSource.fingerprint) return false;
	let bootstrapKey: string | undefined;
	if (templateSource.source === 'seed') {
		if (
			!seedItems ||
			canonicalFingerprint({ blocks, items: seedItems }) !== templateSource.bootstrapKey
		)
			throw new ConvexError('Supply the original seed items to repair this seed template source.');
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
		bytes: chunkReadBytes + documentBytes({ ...templateSource, ...update })
	});
	for (const chunk of next)
		await ctx.db.patch('templateSourceChunks', chunk._id, { blocks: chunk.blocks });
	await ctx.db.patch('templateSources', templateSource._id, update);
	// A repair changes the displayed template source fingerprint. Current authoring is unavailable
	// until the repaired source and complete manifest have been audited/certified together.
	const pointer = await currentPointer(ctx, templateSource.companyId);
	if (pointer) {
		const version = await ctx.db.get('templateVersions', pointer.versionId);
		if (version?.templateSourceId === templateSource._id) {
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
export const repairSource = internalMutation({
	args: {
		...templateSourceScope,
		expectedFingerprint: v.string(),
		sourceFingerprint: v.string(),
		resultFingerprint: v.string(),
		assignments: v.array(roleAssignment),
		seedItems: v.optional(v.array(playbookItem))
	},
	returns: v.object({ fingerprint: v.string(), changed: v.boolean() }),
	handler: async (ctx, args) => {
		requireTransition();
		const { templateSource, blocks, chunks } = await readTemplateSource(
			ctx,
			args.templateSourceId,
			args.companyId
		);
		if (canonicalFingerprint(documentSource(blocks)) !== args.sourceFingerprint)
			throw new ConvexError('Template source changed. Reanalyze this template source.');
		const normalized = assignParagraphRoles(normalizeParagraphBlocks(blocks), args.assignments);
		const result = templateSourceIntegrity(normalized);
		if (result.fingerprint !== args.resultFingerprint)
			throw new ConvexError('The reviewed role map does not match its expected result.');
		if (templateSource.fingerprint === result.fingerprint)
			return { fingerprint: result.fingerprint, changed: false };
		if (templateSource.fingerprint !== args.expectedFingerprint)
			throw new ConvexError('The template source changed. Review the repair again.');
		const changed = await storeRoles(
			ctx,
			templateSource,
			blocks,
			chunks,
			normalized,
			args.seedItems
		);
		return { fingerprint: result.fingerprint, changed };
	}
});

/** Convert remaining prepared/source records without reinterpreting their classifications. */
export const normalizeSources = internalMutation({
	args: { ...scope, seedItems: v.optional(v.array(playbookItem)) },
	returns: progress,
	handler: async (ctx, args) => {
		requireTransition();
		const page = await ctx.db
			.query('templateSources')
			.withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
			.paginate({ cursor: args.cursor, numItems: 1 });
		let changed = 0;
		for (const templateSource of page.page) {
			if (templateSource.state === 'deleting') continue;
			const { blocks, chunks } = await readTemplateSource(
				ctx,
				templateSource._id,
				args.companyId,
				templateSource
			);
			if (
				await storeRoles(
					ctx,
					templateSource,
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
			.query('templateSourceChunks')
			.withIndex('by_companyId_and_templateSourceId_and_order', (q) =>
				q.eq('companyId', args.companyId)
			)
			.paginate({ cursor: args.cursor, numItems: 1 });
		let changed = 0;
		for (const chunk of page.page) {
			const blocks = normalizeParagraphBlocks(chunk.blocks);
			if (canonicalFingerprint(blocks) === canonicalFingerprint(chunk.blocks)) continue;
			const templateSource = await ctx.db.get('templateSources', chunk.templateSourceId);
			if (
				templateSource &&
				(templateSource.companyId !== args.companyId || templateSource.state !== 'deleting')
			)
				throw new ConvexError('Normalize live template sources before detached chunks.');
			await assertStorageCapacity(ctx, {
				documents: 1,
				bytes: documentBytes({ ...chunk, blocks })
			});
			await ctx.db.patch('templateSourceChunks', chunk._id, { blocks });
			changed++;
		}
		return { cursor: page.continueCursor, done: page.isDone, changed };
	}
});

/** Recompute rather than apply deltas: retrying any page is safe. Run after all template sources. */
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
			const templateSource = await readTemplateSourceMetadata(
				ctx,
				version.templateSourceId,
				args.companyId
			);
			let contentReadBytes = templateSource.chunkReadBytes;
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
				templateSource.blocksJsonBytes +
				new TextEncoder().encode(JSON.stringify(items)).byteLength +
				20;
			if (
				templateSource.blockCount !== version.blockCount ||
				items.length !== version.itemCount ||
				snapshotBytes > MAX_SNAPSHOT_BYTES ||
				contentReadBytes + documentBytes(version) + documentBytes(templateSource) + 65_536 >
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
