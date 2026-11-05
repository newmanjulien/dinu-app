import { requireMembership, requirePermission } from './auth';
import { ConvexError, v, type Infer } from 'convex/values';
import type { BaselineBlock } from '../lib/contract/source-model';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { snapshot } from './savedContractValidators';
import { selections } from './contractValidators';
import {
	historicalRevision,
	itemRevision,
	snapshotItem,
	businessItem,
	type HistoricalItem
} from './playbookItemRevisions';
import { MAX_SELECTED_CONCESSIONS } from '../lib/contract/selection-limits';
import {
	MAX_CONTRACT_BLOCKS,
	MAX_PLAYBOOK_ITEMS,
	PlaybookValidationError
} from '../lib/playbook/validation';
import { validatePlaybook } from '../lib/playbook/audit';
import { baselineBlocks, readBaseline, BaselineFingerprintError } from './baselineStorage';

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
export async function assertAuthoringAvailable(ctx: QueryCtx, company: Doc<'company'>) {
	const pointer = await currentPointer(ctx, company._id);
	if (!pointer) throw publicationRejected('The baseline contract is not available.');
	return readLiveSnapshot(ctx, company._id, pointer, company);
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
	knownPointer?: Doc<'currentTemplate'> | null,
	knownCompany?: Doc<'company'>
): Promise<LiveSnapshot> {
	const pointer = knownPointer === undefined ? await currentPointer(ctx, companyId) : knownPointer;
	const company = knownCompany ?? (await ctx.db.get('company', companyId));
	if (!pointer || pointer.companyId !== companyId || !company?.baselineId)
		throw publicationRejected('The baseline contract is not available.');
	const [source, items] = await Promise.all([
		readBaseline(ctx, company.baselineId, companyId),
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

// Complete readers resolve one revision per reference. Source chunks and parent/auth
// reads retain independent native byte/query headroom; JSON output has its own limit.
function snapshotCapacity(captured: LiveSnapshot) {
	const { blocks, items, baseline } = captured;
	const historical = items.map(snapshotItem);
	const snapshotBytes = new TextEncoder().encode(
		JSON.stringify({ blocks, items: historical })
	).byteLength;
	if (
		!blocks.length ||
		blocks.length > MAX_CONTRACT_BLOCKS ||
		items.length > MAX_PLAYBOOK_ITEMS ||
		snapshotBytes > MAX_SNAPSHOT_BYTES
	)
		throw publicationRejected('Contract snapshot exceeds supported size.');
	if (items.some((item) => !item.publishedRevisionId))
		throw publicationRejected('The saved rule revision is missing.');
	const contentReadBytes =
		baseline.chunkReadBytes +
		items.reduce(
			(sum, item) =>
				sum +
				documentBytes({
					...itemRevision(item),
					_id: item.publishedRevisionId!,
					_creationTime: 0 // Native Float64 size is independent of the revision timestamp.
				}),
			0
		);
	return { snapshotBytes, contentReadBytes };
}

/** Publishes the required capture atomically with the caller's authoring change. */
export async function publishTemplate(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	captured: LiveSnapshot,
	knownCompany?: Doc<'company'>
): Promise<Id<'templateVersions'>> {
	const pointer = captured.pointer;
	const baselineId = captured.baseline._id;
	const company = knownCompany ?? (await ctx.db.get('company', companyId));
	if (
		!company ||
		company._id !== companyId ||
		(pointer !== null && pointer.companyId !== companyId) ||
		captured.baseline.companyId !== companyId ||
		captured.baseline.state !== 'published' ||
		(company.baselineId !== undefined && company.baselineId !== baselineId)
	)
		throw publicationRejected('The baseline contract is not available.');
	const capacity = snapshotCapacity(captured);
	try {
		validatePlaybook(captured.blocks, captured.items.map(businessItem));
	} catch (error) {
		if (error instanceof PlaybookValidationError) throw publicationRejected(error.message);
		throw error;
	}
	if (
		captured.items.some((item) => item.companyId !== companyId) ||
		new Set(captured.items.map((item) => item._id)).size !== captured.items.length
	)
		throw publicationRejected('The saved rule revision is missing.');
	const version = {
		companyId,
		publishedAt: Date.now(),
		blockCount: captured.blocks.length,
		itemCount: captured.items.length,
		...capacity,
		baselineId,
		items: captured.items.map((item) => ({
			itemId: item._id,
			revisionId: item.publishedRevisionId!
		}))
	};
	const versionId = await writePublication(ctx, pointer, captured.baseline, version);
	if (!company.baselineId) {
		await publicationCapacity(ctx, {
			documents: 1,
			bytes: documentBytes({ ...company, baselineId })
		});
		await ctx.db.patch('company', companyId, { baselineId });
	}
	return versionId;
}

type Publication = Omit<Doc<'templateVersions'>, '_id' | '_creationTime' | 'draft'>;

/** Complete native read/result envelope, independent of the mutation's remaining write budget. */
function publicationReadCapacity(version: Publication, baseline: Doc<'baselines'>) {
	const versionBytes = documentBytes(version);
	if (
		!Number.isSafeInteger(version.snapshotBytes) ||
		version.snapshotBytes < 0 ||
		version.snapshotBytes > MAX_SNAPSHOT_BYTES ||
		!Number.isSafeInteger(version.contentReadBytes) ||
		version.contentReadBytes < 0 ||
		version.contentReadBytes + versionBytes + documentBytes(baseline) + 65_536 > 16 * 1024 * 1024 ||
		// Revisions use individual gets; all chunks use one indexed query.
		version.itemCount + 3 + 64 > 4096 ||
		version.itemCount + baseline.chunkCount + 2 + 64 > 32_000
	)
		throw publicationRejected('Contract snapshot exceeds supported read capacity.');
	// Revision/chunk wrappers exceed the historical projection's native size. The
	// 64 KiB reserve also covers the result's four fields and parent/access reads.
	return versionBytes;
}

async function writePublication(
	ctx: MutationCtx,
	pointer: Doc<'currentTemplate'> | null,
	baseline: Doc<'baselines'>,
	version: Publication
) {
	const current = pointer ? await ctx.db.get('templateVersions', pointer.versionId) : null;
	if (pointer && (!current || current.companyId !== version.companyId))
		throw publicationRejected('The baseline contract is not available.');
	const stored = { ...version, draft: true };
	const bytes = publicationReadCapacity(stored, baseline);
	await publicationCapacity(ctx, { documents: 1, bytes });
	// A draft version has no contracts. The first contract atomically clears this
	// flag, avoiding a reverse lookup over historical receipts.
	// Replacing it avoids writing another full item manifest for every edit.
	if (pointer && current?.draft) {
		await ctx.db.replace('templateVersions', current._id, stored);
		return current._id;
	}
	const versionId = await ctx.db.insert('templateVersions', stored);
	const nextPointer = { companyId: version.companyId, versionId };
	await publicationCapacity(ctx, { documents: 1, bytes: documentBytes(nextPointer) });
	if (pointer) await ctx.db.replace('currentTemplate', pointer._id, nextPointer);
	else await ctx.db.insert('currentTemplate', nextPointer);
	return versionId;
}

export function isMutableTemplateVersion(version: Doc<'templateVersions'> | null) {
	return Boolean(version?.draft);
}

/** Only for exact structure equality after local validation, before writing the new head. */
export async function instructionPublication(
	ctx: QueryCtx,
	company: Doc<'company'>,
	current: Doc<'playbookItems'>
) {
	const pointer = await currentPointer(ctx, company._id);
	if (!pointer || !company.baselineId)
		throw publicationRejected('The baseline contract is not available.');
	const [version, baseline] = await Promise.all([
		ctx.db.get('templateVersions', pointer.versionId),
		ctx.db.get('baselines', company.baselineId)
	]);
	if (
		!version ||
		version.companyId !== company._id ||
		version.baselineId !== company.baselineId ||
		!baseline ||
		baseline.companyId !== company._id ||
		baseline.state !== 'published' ||
		baseline.blockCount !== version.blockCount
	)
		throw publicationRejected('The baseline contract is not available.');
	const references = versionReferences(version);
	if (
		!current.publishedRevisionId ||
		references.get(current._id)?.revisionId !== current.publishedRevisionId
	)
		throw publicationRejected('The saved rule revision is missing.');
	return { pointer, version, baseline };
}

/** Canonical writers preserve audited structure; this substitution carries that proof forward. */
export async function publishInstructions(
	ctx: MutationCtx,
	publication: Awaited<ReturnType<typeof instructionPublication>>,
	current: Doc<'playbookItems'>,
	next: Doc<'playbookItems'>
) {
	const { pointer, version, baseline } = publication;
	const jsonBytes = (item: Doc<'playbookItems'> | HistoricalItem) =>
		new TextEncoder().encode(JSON.stringify(snapshotItem(item))).byteLength;
	const revisionBytes = (item: Doc<'playbookItems'>) =>
		documentBytes({ ...itemRevision(item), _id: item.publishedRevisionId!, _creationTime: 0 });
	// Count exact historical identities and actual assigned revision IDs. Array
	// punctuation, source, membership and order are unchanged, so only this body differs.
	return writePublication(ctx, pointer, baseline, {
		companyId: version.companyId,
		baselineId: version.baselineId,
		publishedAt: Date.now(),
		blockCount: version.blockCount,
		itemCount: version.itemCount,
		snapshotBytes: version.snapshotBytes + jsonBytes(next) - jsonBytes(current),
		contentReadBytes: version.contentReadBytes + revisionBytes(next) - revisionBytes(current),
		items: version.items.map((reference) =>
			reference.itemId === current._id
				? { itemId: current._id, revisionId: next.publishedRevisionId! }
				: reference
		)
	});
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
		return pointer ? { versionId: pointer.versionId } : null;
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
async function versionReader(
	ctx: QueryCtx,
	versionId: Id<'templateVersions'>,
	companyId: Id<'company'>
) {
	const storedVersion = await ctx.db.get('templateVersions', versionId);
	if (!storedVersion || storedVersion.companyId !== companyId)
		throw new ConvexError('This template version is unavailable.');
	const version = storedVersion;
	const { blockCount, itemCount, baselineId } = version;
	const references = versionReferences(version);
	const resolved = new Map<Id<'playbookItems'>, Promise<HistoricalItem>>();
	function resolve(reference: VersionReference) {
		let result = resolved.get(reference.itemId);
		if (!result) {
			result = resolveVersionItem(ctx, version, reference);
			resolved.set(reference.itemId, result);
		}
		return result;
	}
	function item(id: Id<'playbookItems'>) {
		const reference = references.get(id);
		return reference ? resolve(reference) : Promise.resolve(null);
	}
	async function readItems() {
		const items: HistoricalItem[] = [];
		for (let offset = 0; offset < version.items.length; offset += 64)
			items.push(...(await Promise.all(version.items.slice(offset, offset + 64).map(resolve))));
		return items;
	}
	async function blocks() {
		const result = await baselineBlocks(ctx, baselineId, companyId);
		if (result.length !== blockCount) throw new ConvexError('This template version is incomplete.');
		return result;
	}
	return {
		blocks,
		item,
		async selectedItems(
			selectedConcessions: Infer<typeof selections>,
			unavailableMessage = 'A selected concession does not belong to this contract.'
		) {
			const selectedIds = Object.keys(selectedConcessions) as Id<'playbookItems'>[];
			if (selectedIds.length > MAX_SELECTED_CONCESSIONS)
				throw new ConvexError('Too many selected concessions.');
			const items: HistoricalItem[] = [];
			// Read only selected bodies. Every lookup uses the one transaction-local map.
			for (let offset = 0; offset < selectedIds.length; offset += 64) {
				const selected = selectedIds.slice(offset, offset + 64);
				const rows = await Promise.all(selected.map(item));
				for (let index = 0; index < rows.length; index++) {
					const saved = rows[index];
					if (!saved?.concessions.some((c) => c.id === selectedConcessions[selected[index]]))
						throw new ConvexError(unavailableMessage);
					items.push(saved);
				}
			}
			return items;
		},
		async read() {
			const [snapshotBlocks, items] = await Promise.all([blocks(), readItems()]);
			return { blockCount, itemCount, blocks: snapshotBlocks, items };
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
			baseline.source !== 'docx' ||
			baseline.uploaderId !== access._id ||
			baseline.state === 'deleting'
		)
			throw publicationRejected('This upload is unavailable. Select the DOCX again.');
		if (baseline.issues.some((issue) => issue.severity === 'error'))
			throw publicationRejected('Resolve the document conversion errors before publishing.');
		const pointer = await currentPointer(ctx, access.companyId);
		const currentBaseline = access.company.baselineId
			? await ctx.db.get('baselines', access.company.baselineId)
			: null;
		if (
			pointer &&
			currentBaseline?.state === 'published' &&
			currentBaseline.fingerprint === baseline.fingerprint
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
		if (access.company.baselineId || pointer || items.length || versions.length)
			throw publicationRejected(
				'This company already has a baseline or an import in progress. Its baseline cannot be replaced.'
			);
		let blocks: BaselineBlock[];
		try {
			blocks = await baselineBlocks(ctx, preparedBaselineId, access.companyId, baseline);
		} catch (error) {
			if (error instanceof BaselineFingerprintError)
				throw publicationRejected(
					'The prepared document failed validation. Select the DOCX again.'
				);
			throw error;
		}
		const { expiresAt, ...source } = baseline;
		const published: Doc<'baselines'> = {
			...source,
			state: 'published',
			publishedAt: Date.now()
		};
		await publicationCapacity(ctx, {
			documents: 1,
			bytes: documentBytes(published)
		});
		const { _id, _creationTime, ...stored } = published;
		await ctx.db.replace('baselines', preparedBaselineId, stored);
		return publishTemplate(
			ctx,
			access.companyId,
			{
				pointer: null,
				baseline: published,
				blocks,
				items: []
			},
			access.company
		);
	}
});

type VersionReference = Doc<'templateVersions'>['items'][number];
function versionReferences(version: Doc<'templateVersions'>) {
	const { blockCount, itemCount } = version;
	const references = new Map(version.items.map((item) => [item.itemId, item]));
	if (
		!Number.isSafeInteger(blockCount) ||
		blockCount < 1 ||
		blockCount > MAX_CONTRACT_BLOCKS ||
		!Number.isSafeInteger(itemCount) ||
		itemCount < 0 ||
		itemCount > MAX_PLAYBOOK_ITEMS ||
		version.items.length !== itemCount ||
		references.size !== itemCount ||
		new Set(version.items.map((item) => item.revisionId)).size !== itemCount
	)
		throw new ConvexError('This template version is incomplete.');
	return references;
}
async function resolveVersionItem(
	ctx: QueryCtx,
	version: Doc<'templateVersions'>,
	reference: VersionReference
): Promise<HistoricalItem> {
	const revision = await ctx.db.get('playbookItemRevisions', reference.revisionId);
	if (
		!revision ||
		revision.companyId !== version.companyId ||
		revision.itemId !== reference.itemId ||
		!Number.isSafeInteger(revision.revision) ||
		revision.revision < 1 ||
		!Number.isFinite(revision.itemCreatedAt) ||
		revision.itemCreatedAt < 0
	)
		throw new ConvexError('This template version is incomplete.');
	return historicalRevision(revision);
}
