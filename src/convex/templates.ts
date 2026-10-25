import { requireMembership, requirePermission } from './auth';
import { ConvexError, v, type Infer } from 'convex/values';
import type { BaselineBlock } from '../lib/contract/source-model';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { snapshot } from './savedContractValidators';
import { selections } from './contractValidators';
import { MAX_SELECTED_CONCESSIONS } from '../lib/contract/selection-limits';
import {
	MAX_CONTRACT_BLOCKS,
	MAX_PLAYBOOK_ITEMS,
	PlaybookValidationError
} from '../lib/playbook/validation';
import { validatePlaybook } from '../lib/playbook/audit';
import {
	baselineBlocks,
	readBaseline,
	canonicalBaselineFingerprint,
	snapshotItem,
	businessItem,
	type HistoricalItem
} from './baselineStorage';

import {
	documentBytes,
	publicationCapacity,
	publicationRejected,
	MAX_SNAPSHOT_BYTES
} from './templateCapacity';
export function currentPointer(ctx: QueryCtx, companyId: Id<'company'>) {
	return ctx.db
		.query('currentTemplate')
		.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
		.unique();
}
export async function assertAuthoringAvailable(ctx: QueryCtx, companyId: Id<'company'>) {
	const pointer = await currentPointer(ctx, companyId);
	if (pointer?.maintenance)
		throw publicationRejected('Template maintenance is in progress. Try again shortly.');
	if (!pointer?.versionId) throw publicationRejected('The baseline contract is not available.');
	return readLiveSnapshot(ctx, companyId, pointer);
}
export type LiveSnapshot = {
	pointer: Doc<'currentTemplate'> | null;
	baseline: Doc<'baselines'>;
	blocks: BaselineBlock[];
	items: Doc<'playbookItems'>[];
};
export async function readLiveSnapshot(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	knownPointer?: Doc<'currentTemplate'> | null
): Promise<LiveSnapshot> {
	const pointer = knownPointer === undefined ? await currentPointer(ctx, companyId) : knownPointer;
	if (!pointer) throw publicationRejected('The baseline contract is not available.');
	const [source, items] = await Promise.all([
		readBaseline(ctx, pointer.baselineId, companyId),
		ctx.db
			.query('playbookItems')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(MAX_PLAYBOOK_ITEMS + 1)
	]);
	const records = source.blocks;
	if (!records.length) throw publicationRejected('The baseline contract is not available.');
	if (records.length > MAX_CONTRACT_BLOCKS || items.length > MAX_PLAYBOOK_ITEMS)
		throw publicationRejected('Contract exceeds supported size.');
	return {
		pointer,
		baseline: source.baseline,
		blocks: records,
		items
	};
}

// Full reads need one query per revision, plus at most 96 queries for parent/auth reads.
// Use complete stored wrappers when checking the independent native read envelope.
const measurementId = 'x'.repeat(32);
function snapshotCapacity(
	blocks: LiveSnapshot['blocks'],
	items: LiveSnapshot['items'],
	baseline: Doc<'baselines'>
) {
	const historical = items.map(snapshotItem);
	const bytes = new TextEncoder().encode(JSON.stringify({ blocks, items: historical })).byteLength;
	if (
		!blocks.length ||
		blocks.length > MAX_CONTRACT_BLOCKS ||
		items.length > MAX_PLAYBOOK_ITEMS ||
		bytes > MAX_SNAPSHOT_BYTES
	)
		throw publicationRejected('Contract snapshot exceeds supported size.');
	const companyId = items[0]?.companyId ?? measurementId;
	const manifest = {
		companyId,
		versionId: measurementId,
		itemId: measurementId,
		revisionId: measurementId
	};
	const readBytes =
		blocks.reduce(
			(sum, block) => sum + documentBytes({ ...block, companyId, baselineId: measurementId }),
			0
		) +
		historical.reduce(
			(sum, item) =>
				sum + documentBytes({ companyId, itemId: item._id, item }) + documentBytes(manifest),
			0
		);
	if (readBytes + documentBytes(baseline) + 65_536 > 16 * 1024 * 1024)
		throw publicationRejected('Contract snapshot exceeds supported read capacity.');
	return bytes;
}

/** Publishes the required capture atomically with the caller's authoring change. */
export async function publishTemplate(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	captured: LiveSnapshot
): Promise<Id<'templateVersions'>> {
	const pointer = captured.pointer;
	const baselineId = captured.baseline._id;
	const bytes = snapshotCapacity(captured.blocks, captured.items, captured.baseline);
	try {
		validatePlaybook(captured.blocks, captured.items.map(businessItem));
	} catch (error) {
		if (error instanceof PlaybookValidationError) throw publicationRejected(error.message);
		throw error;
	}
	if (captured.items.some((item) => !item.publishedRevisionId))
		throw publicationRejected('The saved rule revision is missing.');
	const version = {
		companyId,
		publishedAt: Date.now(),
		blockCount: captured.blocks.length,
		itemCount: captured.items.length,
		snapshotBytes: bytes,
		baselineId
	};
	await publicationCapacity(ctx, { documents: 1, bytes: documentBytes(version) });
	const versionId = await ctx.db.insert('templateVersions', version);
	const rows = captured.items.map((item) => ({
		companyId,
		versionId,
		itemId: item._id,
		revisionId: item.publishedRevisionId!
	}));
	await publicationCapacity(ctx, {
		documents: rows.length,
		bytes: rows.reduce((sum, row) => sum + documentBytes(row), 0)
	});
	for (const row of rows) await ctx.db.insert('templateVersionItems', row);
	const nextPointer = {
		...(pointer ?? {
			companyId,
			baselineId,
			baselineFingerprint: captured.baseline.fingerprint,
			maintenance: false
		}),
		versionId
	};
	await publicationCapacity(ctx, { documents: 1, bytes: documentBytes(nextPointer) });
	if (pointer) {
		const { _id, _creationTime, ...stored } = nextPointer as Doc<'currentTemplate'>;
		await ctx.db.replace('currentTemplate', pointer._id, stored);
	} else await ctx.db.insert('currentTemplate', nextPointer);
	return versionId;
}
export async function readVersion(
	ctx: QueryCtx,
	versionId: Id<'templateVersions'>,
	companyId: Id<'company'>
) {
	return (await versionReader(ctx, versionId, companyId)).read();
}
export const current = query({
	args: { membershipId: v.id('memberships') },
	returns: v.union(v.null(), v.object({ versionId: v.id('templateVersions') })),
	handler: async (ctx, args) => {
		const { companyId } = await requireMembership(ctx, args.membershipId);
		const pointer = await currentPointer(ctx, companyId);
		return pointer?.versionId && !pointer.maintenance
			? {
					versionId: pointer.versionId
				}
			: null;
	}
});
export const version = query({
	args: { membershipId: v.id('memberships'), versionId: v.id('templateVersions') },
	returns: snapshot,
	handler: async (ctx, { versionId, membershipId }) => {
		const { companyId } = await requireMembership(ctx, membershipId);
		return readVersion(ctx, versionId, companyId);
	}
});
// Callers authorize the company or contract first. Validate the immutable parent
// once per transaction; use its counts for every complete read.
export function snapshotReader(
	ctx: QueryCtx,
	contract: Pick<Doc<'savedContracts'>, 'templateVersionId' | 'companyId'>
) {
	return versionReader(ctx, contract.templateVersionId, contract.companyId);
}
async function readManifestItem(
	ctx: QueryCtx,
	version: Doc<'templateVersions'>,
	itemId: Id<'playbookItems'>
) {
	const versionId = version._id;
	const row = await ctx.db
		.query('templateVersionItems')
		.withIndex('by_versionId_and_itemId', (q) => q.eq('versionId', versionId).eq('itemId', itemId))
		.unique();
	return row ? resolveVersionItem(ctx, version, row) : null;
}
async function versionReader(
	ctx: QueryCtx,
	versionId: Id<'templateVersions'>,
	companyId: Id<'company'>
) {
	const version = await ctx.db.get('templateVersions', versionId);
	if (!version || version.companyId !== companyId)
		throw new ConvexError('This template version is unavailable.');
	const { blockCount, itemCount, baselineId } = version;
	async function blocks() {
		const result = await baselineBlocks(ctx, baselineId, companyId);
		if (result.length !== blockCount) throw new ConvexError('This template version is incomplete.');
		return result;
	}
	return {
		blocks,
		item: (id: Id<'playbookItems'>) => readManifestItem(ctx, version, id),
		async selectedItems(selectedConcessions: Infer<typeof selections>) {
			const selectedIds = Object.keys(selectedConcessions) as Id<'playbookItems'>[];
			if (selectedIds.length > MAX_SELECTED_CONCESSIONS)
				throw new ConvexError('Too many selected concessions.');
			const items: HistoricalItem[] = [];
			// Read only selected items, with bounded concurrent I/O.
			for (let offset = 0; offset < selectedIds.length; offset += 64) {
				const selected = selectedIds.slice(offset, offset + 64);
				const rows = await Promise.all(selected.map((id) => readManifestItem(ctx, version, id)));
				for (let index = 0; index < rows.length; index++) {
					const item = rows[index];
					if (!item?.concessions.some((c) => c.id === selectedConcessions[selected[index]]))
						throw new ConvexError('A selected concession does not belong to this contract.');
					items.push(item);
				}
			}
			return items;
		},
		async read() {
			const [snapshotBlocks, items] = await Promise.all([
				blocks(),
				ctx.db
					.query('templateVersionItems')
					.withIndex('by_versionId', (q) => q.eq('versionId', versionId))
					.take(MAX_PLAYBOOK_ITEMS + 1)
			]);
			if (items.length !== itemCount) throw new ConvexError('This template version is incomplete.');
			return {
				blockCount,
				itemCount,
				blocks: snapshotBlocks,
				items: await resolveVersionItems(ctx, version, items)
			};
		}
	};
}

/** One permanent baseline; prepared conversion cannot establish company state. */
export const publishBaseline = mutation({
	args: { membershipId: v.id('memberships'), preparedBaselineId: v.id('baselines') },
	returns: v.id('templateVersions'),
	handler: async (ctx, { membershipId, preparedBaselineId }) => {
		const access = await requirePermission(ctx, 'manageTemplate', membershipId);
		const baseline = await ctx.db.get('baselines', preparedBaselineId);
		if (
			!baseline ||
			baseline.companyId !== access.companyId ||
			baseline.uploaderId !== access._id ||
			baseline.source !== 'docx' ||
			baseline.state === 'deleting'
		)
			throw publicationRejected('This upload is unavailable. Select the DOCX again.');
		if (baseline.issues.some((issue) => issue.severity === 'error'))
			throw publicationRejected('Resolve the document conversion errors before publishing.');
		const pointer = await currentPointer(ctx, access.companyId);
		if (
			pointer?.versionId &&
			!pointer.maintenance &&
			pointer.baselineFingerprint === baseline.fingerprint
		)
			return pointer.versionId;
		if (baseline.state !== 'prepared' || !baseline.expiresAt || baseline.expiresAt <= Date.now())
			throw publicationRejected('This upload has expired. Select the DOCX again.');
		const [items, versions] = await Promise.all([
			ctx.db
				.query('playbookItems')
				.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
				.take(1),
			ctx.db
				.query('templateVersions')
				.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
				.take(1)
		]);
		if (pointer || items.length || versions.length)
			throw publicationRejected(
				'This company already has a baseline or an import in progress. Its baseline cannot be replaced.'
			);
		const blocks = await baselineBlocks(ctx, preparedBaselineId, access.companyId, baseline);
		if (canonicalBaselineFingerprint(blocks) !== baseline.fingerprint)
			throw publicationRejected('The prepared document failed validation. Select the DOCX again.');
		await publicationCapacity(ctx, {
			documents: 1,
			bytes: documentBytes({ ...baseline, state: 'published', publishedAt: Date.now() })
		});
		await ctx.db.patch('baselines', preparedBaselineId, {
			state: 'published',
			publishedAt: Date.now(),
			expiresAt: undefined
		});
		return publishTemplate(ctx, access.companyId, { pointer: null, baseline, blocks, items: [] });
	}
});

async function resolveVersionItem(
	ctx: QueryCtx,
	version: Doc<'templateVersions'>,
	row: Doc<'templateVersionItems'>
) {
	if (row.companyId !== version.companyId || row.versionId !== version._id)
		throw new ConvexError('This template version is incomplete.');
	const revision = await ctx.db.get('playbookItemRevisions', row.revisionId);
	if (
		!revision ||
		revision.companyId !== row.companyId ||
		revision.itemId !== row.itemId ||
		revision.item.companyId !== row.companyId ||
		revision.item._id !== row.itemId
	)
		throw new ConvexError('This template version is incomplete.');
	return revision.item;
}

async function resolveVersionItems(
	ctx: QueryCtx,
	version: Doc<'templateVersions'>,
	rows: Doc<'templateVersionItems'>[]
) {
	const items: HistoricalItem[] = [];
	for (let offset = 0; offset < rows.length; offset += 64)
		items.push(
			...(await Promise.all(
				rows.slice(offset, offset + 64).map((row) => resolveVersionItem(ctx, version, row))
			))
		);
	return items;
}
