import { ConvexError, getConvexSize, v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { requireCompany } from './auth';
import { baselineBlock } from './sourceValidators';
import { playbookItem } from './playbookValidators';
import {
	baselineIntegrity,
	canonicalFingerprint,
	planBaselineChunks,
	writeBaselineChunks
} from './baselineStorage';
import {
	createAuthoringItem,
	businessItem,
	snapshotItem,
	historicalRevision
} from './playbookItemRevisions';
import { currentPointer, publishTemplate, readLiveSnapshot } from './templates';
import {
	documentBytes,
	publicationCapacity,
	MAX_SNAPSHOT_BYTES,
	publicationRejected
} from './templateCapacity';
import { validatePlaybook } from '../lib/playbook/audit';
import { MAX_PLAYBOOK_ITEMS } from '../lib/playbook/validation';
import type { BaselineBlock } from '../lib/contract/source-model';
import { normalizePlaybookItem, type PlaybookItem } from '../lib/playbook/model';

const seedProjection = v.object({ blocks: v.array(baselineBlock), items: v.array(playbookItem) });
const refuseOverwrite = () =>
	new ConvexError(
		'This company already has template data or another import. Refusing to overwrite it.'
	);
const incomplete = () => new ConvexError('The published seed is incomplete.');
const measurementId = 'x'.repeat(32);

function digest(blocks: readonly BaselineBlock[], items: readonly PlaybookItem[]) {
	return canonicalFingerprint({ blocks, items });
}

function assertSeedResultCapacity(blocks: BaselineBlock[], items: PlaybookItem[]) {
	// The read-back API returns both live and historical business projections.
	if (getConvexSize({ blocks, items, publication: { blocks, items } }) > 16 * 1024 * 1024)
		throw publicationRejected('The seed verification result exceeds supported size.');
}

/** Verify ordinary source, live heads and immutable publication before considering replay. */
async function publishedSeed(
	ctx: QueryCtx,
	company: Doc<'company'>,
	knownRevisions?: Doc<'playbookItemRevisions'>[]
) {
	const pointer = await currentPointer(ctx, company._id);
	if (!company.baselineId || !pointer) throw incomplete();
	const live = await readLiveSnapshot(ctx, company._id, pointer, company);
	if (live.baseline.source !== 'seed' || live.baseline.state !== 'published') throw incomplete();
	if (!Number.isSafeInteger(live.baseline.publishedAt) || live.baseline.publishedAt < 0)
		throw incomplete();
	const version = await ctx.db.get('templateVersions', pointer.versionId);
	if (
		!version ||
		version.companyId !== company._id ||
		version.baselineId !== company.baselineId ||
		version.blockCount !== live.blocks.length ||
		version.itemCount !== live.items.length ||
		version.items.length !== live.items.length ||
		new Set(version.items.map((item) => item.itemId)).size !== live.items.length ||
		new Set(version.items.map((item) => item.revisionId)).size !== live.items.length ||
		!Number.isSafeInteger(version.publishedAt) ||
		version.publishedAt < 0
	)
		throw incomplete();
	// Reuse the already verified permanent source. Resolve every immutable body and
	// compare it independently with its live head; bootstrap replay can reuse its scan.
	const known =
		knownRevisions && new Map(knownRevisions.map((revision) => [revision._id, revision]));
	const revisions: Doc<'playbookItemRevisions'>[] = [];
	for (let offset = 0; offset < version.items.length; offset += 64) {
		const rows = await Promise.all(
			version.items
				.slice(offset, offset + 64)
				.map((reference) =>
					known
						? known.get(reference.revisionId)
						: ctx.db.get('playbookItemRevisions', reference.revisionId)
				)
		);
		for (const row of rows) {
			if (!row) throw incomplete();
			revisions.push(row);
		}
	}
	const publication = { blocks: live.blocks, items: revisions.map(historicalRevision) };
	for (const [index, item] of live.items.entries()) {
		const historical = publication.items[index];
		const manifest = version.items[index];
		if (
			!item.publishedRevisionId ||
			item.companyId !== company._id ||
			!Number.isSafeInteger(item.revision) ||
			item.revision < 1 ||
			manifest.itemId !== item._id ||
			manifest.revisionId !== item.publishedRevisionId ||
			historical.companyId !== company._id ||
			historical._id !== item._id ||
			historical._creationTime !== item._creationTime ||
			historical.revision !== item.revision ||
			canonicalFingerprint(historical) !== canonicalFingerprint(snapshotItem(item))
		)
			throw incomplete();
	}
	const contentReadBytes =
		live.baseline.chunkReadBytes +
		revisions.reduce((sum, revision) => sum + documentBytes(revision), 0);
	if (
		version.contentReadBytes !== contentReadBytes ||
		version.snapshotBytes !== new TextEncoder().encode(JSON.stringify(publication)).byteLength
	)
		throw incomplete();
	const blocks = live.blocks;
	const items = live.items.map(businessItem);
	const publishedItems = publication.items.map(businessItem);
	validatePlaybook(blocks, items);
	// Exact source and full historical business equality above make a second audit redundant.
	const projection = {
		blocks,
		items,
		publication: { blocks: publication.blocks, items: publishedItems }
	};
	assertSeedResultCapacity(blocks, items);
	return {
		baseline: live.baseline,
		versionId: pointer.versionId,
		projection
	};
}

/** Canonical seed setup is one transaction; a lost response can only replay a complete seed. */
export const bootstrap = internalMutation({
	args: { companyId: v.id('company'), ...seedProjection.fields },
	returns: v.object({ baselineId: v.id('baselines'), versionId: v.id('templateVersions') }),
	handler: async (ctx, { companyId, blocks, items }) => {
		const canonicalItems = items.map(normalizePlaybookItem);
		const company = await requireCompany(ctx, companyId);
		// Bootstrap uses the same canonical content and geometry invariants as app publication.
		validatePlaybook(blocks, canonicalItems);
		const bootstrapKey = digest(blocks, canonicalItems);
		const [pointer, baselines, heads, versions, revisions, chunks, receipts] = await Promise.all([
			currentPointer(ctx, companyId),
			ctx.db
				.query('baselines')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
				.take(2),
			ctx.db
				.query('playbookItems')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
				.take(1),
			ctx.db
				.query('templateVersions')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
				.take(2),
			ctx.db
				.query('playbookItemRevisions')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
				.take(Math.min(items.length, MAX_PLAYBOOK_ITEMS) + 1),
			ctx.db
				.query('baselineChunks')
				.withIndex('by_companyId_and_baselineId_and_order', (q) => q.eq('companyId', companyId))
				.take(1),
			ctx.db
				.query('creationReceipts')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
				.take(1)
		]);
		if (
			company.baselineId ||
			pointer ||
			baselines.length ||
			heads.length ||
			versions.length ||
			revisions.length ||
			chunks.length ||
			receipts.length
		) {
			// Read and validate current published data even when the caller supplied a different digest.
			let existing: Awaited<ReturnType<typeof publishedSeed>>;
			try {
				existing = await publishedSeed(ctx, company, revisions);
			} catch {
				throw refuseOverwrite();
			}
			if (
				baselines.length !== 1 ||
				versions.length !== 1 ||
				receipts.length !== 0 ||
				revisions.length !== items.length ||
				revisions.some((revision) => revision.revision !== 1) ||
				existing.baseline.bootstrapKey !== bootstrapKey ||
				digest(existing.projection.blocks, existing.projection.items) !== bootstrapKey ||
				digest(existing.projection.publication.blocks, existing.projection.publication.items) !==
					bootstrapKey
			)
				throw refuseOverwrite();
			return { baselineId: existing.baseline._id, versionId: existing.versionId };
		}

		// Reject a native read-back limit before creating a seed that cannot be verified.
		assertSeedResultCapacity(blocks, canonicalItems);
		const baseline = {
			companyId,
			source: 'seed' as const,
			state: 'published' as const,
			...baselineIntegrity(blocks),
			bootstrapKey,
			publishedAt: Date.now(),
			issues: [],
			blockCount: blocks.length,
			chunkCount: 0,
			chunkReadBytes: 0
		};
		// Plan the complete native envelope before allocating any seed data. Writers recheck
		// remaining capacity with actual IDs and wrappers after each allocation group.
		const plannedChunks = planBaselineChunks({
			companyId,
			baselineId: measurementId as Id<'baselines'>,
			blocks
		});
		const historical = canonicalItems.map((item) => ({
			...item,
			companyId,
			_id: measurementId,
			_creationTime: baseline.publishedAt,
			revision: 1
		}));
		const snapshotBytes = new TextEncoder().encode(
			JSON.stringify({ blocks, items: historical })
		).byteLength;
		if (snapshotBytes > MAX_SNAPSHOT_BYTES)
			throw publicationRejected('Contract snapshot exceeds supported size.');
		const chunkBytes = plannedChunks.reduce((sum, chunk) => sum + documentBytes(chunk), 0);
		let itemBytes = 0;
		let contentReadBytes = chunkBytes;
		for (const item of historical) {
			const revision = {
				companyId,
				itemId: measurementId,
				itemCreatedAt: item._creationTime,
				revision: 1,
				body: businessItem(item)
			};
			const head = { ...item, publishedRevisionId: measurementId };
			itemBytes += documentBytes(item) + documentBytes(head) + documentBytes(revision);
			contentReadBytes += documentBytes(revision);
		}
		const versionBytes = documentBytes({
			companyId,
			baselineId: measurementId,
			publishedAt: baseline.publishedAt,
			blockCount: blocks.length,
			itemCount: canonicalItems.length,
			snapshotBytes,
			contentReadBytes,
			items: canonicalItems.map(() => ({ itemId: measurementId, revisionId: measurementId }))
		});
		if (contentReadBytes + versionBytes + documentBytes(baseline) + 65_536 > 16 * 1024 * 1024)
			throw publicationRejected('Contract snapshot exceeds supported read capacity.');
		await publicationCapacity(ctx, {
			documents: plannedChunks.length + canonicalItems.length * 3 + 5,
			bytes: chunkBytes + itemBytes + documentBytes(baseline) * 2 + versionBytes + 4096,
			queries: plannedChunks.length + canonicalItems.length + 8,
			readDocuments: plannedChunks.length + canonicalItems.length + 8,
			readBytes: chunkBytes + historical.reduce((sum, item) => sum + documentBytes(item), 0)
		});
		const baselineId = await ctx.db.insert('baselines', baseline);
		const counters = await writeBaselineChunks(ctx, { companyId, baselineId, blocks });
		await publicationCapacity(ctx, {
			documents: 1,
			bytes: documentBytes({ ...baseline, ...counters })
		});
		await ctx.db.patch('baselines', baselineId, counters);
		const savedBaseline = (await ctx.db.get('baselines', baselineId))!;
		const liveItems: Doc<'playbookItems'>[] = [];
		for (const item of canonicalItems)
			liveItems.push(await createAuthoringItem(ctx, { ...item, companyId }));
		const versionId = await publishTemplate(
			ctx,
			companyId,
			{
				pointer: null,
				baseline: savedBaseline,
				blocks,
				items: liveItems
			},
			company
		);
		return { baselineId, versionId };
	}
});

export const readSeed = internalQuery({
	args: { companyId: v.id('company') },
	returns: seedProjection.extend({ publication: seedProjection }),
	handler: async (ctx, { companyId }) =>
		(await publishedSeed(ctx, await requireCompany(ctx, companyId))).projection
});
