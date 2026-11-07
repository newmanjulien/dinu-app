import { ConvexError, getConvexSize, v } from 'convex/values';
import type { BaselineBlock } from '../lib/contract/source-model';
import { baselineBlock } from '../lib/contract/source-validators';
import { validatePlaybook } from '../lib/playbook/audit';
import type { PlaybookItem } from '../lib/playbook/model';
import { MAX_PLAYBOOK_ITEMS } from '../lib/playbook/validation';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { requireCompany } from './auth';
import {
	baselineIntegrity,
	canonicalFingerprint,
	planBaselineChunks,
	writeBaselineChunks
} from './baselineStorage';
import {
	businessItem,
	createAuthoringItem,
	historicalRevision,
	snapshotItem
} from './playbookItemRevisions';
import { playbookItem } from './playbookValidators';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { MAX_SNAPSHOT_BYTES, templateRejected } from './templateCapacity';
import { currentPointer, saveTemplateVersion, readLiveSnapshot } from './templates';

const seedProjection = v.object({ blocks: v.array(baselineBlock), items: v.array(playbookItem) });
const refuseOverwrite = () =>
	new ConvexError(
		'This company already has template data or another import. Refusing to overwrite it.'
	);
const incomplete = () => new ConvexError('The active seed is incomplete.');
const measurementId = 'x'.repeat(32);

function digest(blocks: readonly BaselineBlock[], items: readonly PlaybookItem[]) {
	return canonicalFingerprint({ blocks, items });
}

function assertSeedResultCapacity(blocks: BaselineBlock[], items: PlaybookItem[]) {
	// The read-back API returns both live and historical business projections.
	if (getConvexSize({ blocks, items, snapshot: { blocks, items } }) > 16 * 1024 * 1024)
		throw templateRejected('The seed verification result exceeds supported size.');
}

/** Verify ordinary source, live heads and immutable snapshot before considering replay. */
async function activeSeed(
	ctx: QueryCtx,
	company: Doc<'company'>,
	knownRevisions?: Doc<'playbookItemRevisions'>[]
) {
	const pointer = await currentPointer(ctx, company._id);
	if (!company.baselineId || !pointer) throw incomplete();
	const live = await readLiveSnapshot(ctx, company._id, pointer, company);
	if (live.baseline.source !== 'seed' || live.baseline.state !== 'active') throw incomplete();
	if (!Number.isSafeInteger(live.baseline.activatedAt) || live.baseline.activatedAt < 0)
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
		!Number.isSafeInteger(version.updatedAt) ||
		version.updatedAt < 0
	)
		throw incomplete();
	// Reuse the already verified permanent source. Resolve every immutable body and
	// compare it independently with its live head; bootstrap replay can reuse its scan.
	const known =
		knownRevisions &&
		new Map(knownRevisions.map((contentRevision) => [contentRevision._id, contentRevision]));
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
	const snapshot = { blocks: live.blocks, items: revisions.map(historicalRevision) };
	for (const [index, item] of live.items.entries()) {
		const historical = snapshot.items[index];
		const manifest = version.items[index];
		if (
			!item.currentRevisionId ||
			item.companyId !== company._id ||
			!Number.isSafeInteger(item.contentRevision) ||
			item.contentRevision < 1 ||
			manifest.itemId !== item._id ||
			manifest.revisionId !== item.currentRevisionId ||
			historical.companyId !== company._id ||
			historical._id !== item._id ||
			historical._creationTime !== item._creationTime ||
			historical.contentRevision !== item.contentRevision ||
			canonicalFingerprint(historical) !== canonicalFingerprint(snapshotItem(item))
		)
			throw incomplete();
	}
	const contentReadBytes =
		live.baseline.chunkReadBytes +
		revisions.reduce((sum, contentRevision) => sum + documentBytes(contentRevision), 0);
	if (
		version.contentReadBytes !== contentReadBytes ||
		version.snapshotBytes !== new TextEncoder().encode(JSON.stringify(snapshot)).byteLength
	)
		throw incomplete();
	const blocks = live.blocks;
	const items = live.items.map(businessItem);
	const versionItems = snapshot.items.map(businessItem);
	validatePlaybook(blocks, items);
	// Exact source and full historical business equality above make a second audit redundant.
	const projection = {
		blocks,
		items,
		snapshot: { blocks: snapshot.blocks, items: versionItems }
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
		const company = await requireCompany(ctx, companyId);
		// Bootstrap uses the same canonical content and geometry invariants as template saves.
		validatePlaybook(blocks, items);
		const bootstrapKey = digest(blocks, items);
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
				.query('playbookItemCreationReceipts')
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
			// Read and validate current active data even when the caller supplied a different digest.
			let existing: Awaited<ReturnType<typeof activeSeed>>;
			try {
				existing = await activeSeed(ctx, company, revisions);
			} catch {
				throw refuseOverwrite();
			}
			if (
				baselines.length !== 1 ||
				versions.length !== 1 ||
				receipts.length !== 0 ||
				revisions.length !== items.length ||
				revisions.some((contentRevision) => contentRevision.contentRevision !== 1) ||
				existing.baseline.bootstrapKey !== bootstrapKey ||
				digest(existing.projection.blocks, existing.projection.items) !== bootstrapKey ||
				digest(existing.projection.snapshot.blocks, existing.projection.snapshot.items) !==
					bootstrapKey
			)
				throw refuseOverwrite();
			return { baselineId: existing.baseline._id, versionId: existing.versionId };
		}

		// Reject a native read-back limit before creating a seed that cannot be verified.
		assertSeedResultCapacity(blocks, items);
		const baseline = {
			companyId,
			source: 'seed' as const,
			state: 'active' as const,
			...baselineIntegrity(blocks),
			bootstrapKey,
			activatedAt: Date.now(),
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
		const historical = items.map((item) => ({
			...item,
			companyId,
			_id: measurementId,
			_creationTime: baseline.activatedAt,
			contentRevision: 1
		}));
		const snapshotBytes = new TextEncoder().encode(
			JSON.stringify({ blocks, items: historical })
		).byteLength;
		if (snapshotBytes > MAX_SNAPSHOT_BYTES)
			throw templateRejected('Contract snapshot exceeds supported size.');
		const chunkBytes = plannedChunks.reduce((sum, chunk) => sum + documentBytes(chunk), 0);
		let itemBytes = 0;
		let contentReadBytes = chunkBytes;
		for (const item of historical) {
			const contentRevision = {
				companyId,
				itemId: measurementId,
				itemCreatedAt: item._creationTime,
				contentRevision: 1,
				body: businessItem(item)
			};
			const head = { ...item, currentRevisionId: measurementId };
			itemBytes += documentBytes(item) + documentBytes(head) + documentBytes(contentRevision);
			contentReadBytes += documentBytes(contentRevision);
		}
		const versionBytes = documentBytes({
			companyId,
			baselineId: measurementId,
			updatedAt: baseline.activatedAt,
			blockCount: blocks.length,
			itemCount: items.length,
			snapshotBytes,
			contentReadBytes,
			items: items.map(() => ({ itemId: measurementId, revisionId: measurementId }))
		});
		if (contentReadBytes + versionBytes + documentBytes(baseline) + 65_536 > 16 * 1024 * 1024)
			throw templateRejected('Contract snapshot exceeds supported read capacity.');
		await assertStorageCapacity(ctx, {
			documents: plannedChunks.length + items.length * 3 + 5,
			bytes: chunkBytes + itemBytes + documentBytes(baseline) * 2 + versionBytes + 4096,
			queries: plannedChunks.length + items.length * 2 + 8,
			readDocuments: plannedChunks.length + items.length * 2 + 8,
			readBytes: contentReadBytes + historical.reduce((sum, item) => sum + documentBytes(item), 0)
		});
		const baselineId = await ctx.db.insert('baselines', baseline);
		const counters = await writeBaselineChunks(ctx, { companyId, baselineId, blocks });
		await assertStorageCapacity(ctx, {
			documents: 1,
			bytes: documentBytes({ ...baseline, ...counters })
		});
		await ctx.db.patch('baselines', baselineId, counters);
		const savedBaseline = (await ctx.db.get('baselines', baselineId))!;
		const liveItems: import('../lib/playbook/structure').DetailRecord[] = [];
		for (const item of items)
			liveItems.push(await createAuthoringItem(ctx, { ...item, companyId }));
		const versionId = await saveTemplateVersion(
			ctx,
			companyId,
			{
				pointer: null,
				baseline: savedBaseline,
				blocks,
				items: liveItems,
				normalized: true
			},
			company
		);
		return { baselineId, versionId };
	}
});

export const readSeed = internalQuery({
	args: { companyId: v.id('company') },
	returns: seedProjection.extend({ snapshot: seedProjection }),
	handler: async (ctx, { companyId }) =>
		(await activeSeed(ctx, await requireCompany(ctx, companyId))).projection
});
