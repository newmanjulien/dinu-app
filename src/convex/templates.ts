import { ConvexError, v, getConvexSize, type Infer } from 'convex/values';
import { MAX_SELECTED_CONCESSIONS } from '../lib/contract/selection-limits';
import type { BaselineBlock } from '../lib/contract/source-model';
import { validatePlaybook } from '../lib/playbook/audit';
import {
	MAX_CONTRACT_BLOCKS,
	MAX_PLAYBOOK_ITEMS,
	PlaybookValidationError
} from '../lib/playbook/validation';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { requireMembership, requirePermission } from './auth';
import {
	baselineBlocks,
	BaselineFingerprintError,
	readBaseline,
	canonicalFingerprint
} from './baselineStorage';
import { selections } from './contractValidators';
import {
	businessItem,
	hydrateHead,
	liveRevision,
	compactHead,
	historicalRevision,
	snapshotItem,
	type HistoricalItem
} from './playbookItemRevisions';
import { snapshot } from './savedContractValidators';
import { itemStructure, type DetailRecord } from '../lib/playbook/structure';
import { validationCertified, readValidationCertificate } from './authoringValidation';
import { VALIDATION_CODEC_VERSION } from '../lib/contract/validation-codec';

import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { MAX_SNAPSHOT_BYTES, templateRejected } from './templateCapacity';
export function currentPointer(ctx: QueryCtx, companyId: Id<'company'>) {
	return ctx.db
		.query('currentTemplate')
		.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
		.unique();
}
export type LiveSnapshot = {
	pointer: Doc<'currentTemplate'> | null;
	baseline: Doc<'baselines'>;
	blocks: BaselineBlock[];
	items: DetailRecord[];
	normalized?: boolean;
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
		throw templateRejected('The baseline contract is not available.');
	const [source, items, version] = await Promise.all([
		readBaseline(ctx, company.baselineId, companyId),
		ctx.db
			.query('playbookItems')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(MAX_PLAYBOOK_ITEMS + 1),
		ctx.db.get('templateVersions', pointer.versionId)
	]);
	const records = source.blocks;
	if (!records.length) throw templateRejected('The baseline contract is not available.');
	if (records.length > MAX_CONTRACT_BLOCKS || items.length > MAX_PLAYBOOK_ITEMS)
		throw templateRejected('Contract exceeds supported size.');
	if (!version || version.companyId !== companyId || version.baselineId !== source.baseline._id)
		throw templateRejected('The template version is missing.');
	const ordered = orderedHeads(version, items, false);
	return {
		pointer,
		baseline: source.baseline,
		blocks: records,
		items: await Promise.all(ordered.map((item) => hydrateHead(ctx, item))),
		normalized: items.every((item) => 'format' in item)
	};
}

async function snapshotCapacity(ctx: MutationCtx, captured: LiveSnapshot) {
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
		throw templateRejected('Contract snapshot exceeds supported size.');
	if (items.some((item) => !item.currentRevisionId))
		throw templateRejected('The saved rule revision is missing.');
	let contentReadBytes = baseline.chunkReadBytes;
	// Initial/bulk saves have no prior proof. Count every actual stored wrapper.
	for (let offset = 0; offset < items.length; offset += 64) {
		const batch = items.slice(offset, offset + 64);
		await assertStorageCapacity(ctx, { queries: batch.length, readDocuments: batch.length });
		const revisions = await Promise.all(
			batch.map((item) => ctx.db.get('playbookItemRevisions', item.currentRevisionId!))
		);
		for (let index = 0; index < batch.length; index++) {
			const item = batch[index];
			const revision = revisions[index];
			if (
				!revision ||
				revision.companyId !== item.companyId ||
				revision.itemId !== item._id ||
				revision.contentRevision !== item.contentRevision ||
				revision.itemCreatedAt !== item._creationTime ||
				canonicalFingerprint(businessItem(revision.body)) !==
					canonicalFingerprint(businessItem(item))
			)
				throw templateRejected('The saved rule revision is missing.');
			contentReadBytes += documentBytes(revision);
		}
		await assertStorageCapacity(ctx, {});
	}
	return { snapshotBytes, contentReadBytes };
}

/** Saves the required version atomically with the caller's authoring change. */
export async function saveTemplateVersion(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	captured: LiveSnapshot,
	knownCompany?: Doc<'company'>
): Promise<Id<'templateVersions'>> {
	if (knownCompany?.authoringMigration)
		throw templateRejected(
			'Template authoring is temporarily unavailable while its data is upgraded.'
		);
	const pointer = captured.pointer;
	const baselineId = captured.baseline._id;
	const company = knownCompany ?? (await ctx.db.get('company', companyId));
	if (company?.authoringMigration)
		throw templateRejected(
			'Template authoring is temporarily unavailable while its data is upgraded.'
		);
	if (
		!company ||
		company._id !== companyId ||
		(pointer !== null && pointer.companyId !== companyId) ||
		captured.baseline.companyId !== companyId ||
		captured.baseline.state !== 'active' ||
		(company.baselineId !== undefined && company.baselineId !== baselineId)
	)
		throw templateRejected('The baseline contract is not available.');
	if (captured.items.length && !captured.normalized)
		throw templateRejected('The template needs authoring migration.');
	const capacity = await snapshotCapacity(ctx, captured);
	try {
		validatePlaybook(captured.blocks, captured.items.map(businessItem));
	} catch (error) {
		if (error instanceof PlaybookValidationError) throw templateRejected(error.message);
		throw error;
	}
	if (
		captured.items.some((item) => item.companyId !== companyId) ||
		new Set(captured.items.map((item) => item._id)).size !== captured.items.length
	)
		throw templateRejected('The saved rule revision is missing.');
	const version = {
		companyId,
		updatedAt: Date.now(),
		blockCount: captured.blocks.length,
		itemCount: captured.items.length,
		...capacity,
		validation: { format: 0, fingerprint: captured.baseline.fingerprint },
		structureResultBytes: captured.items.reduce(
			(sum, item) => sum + getConvexSize(itemStructure(item)),
			0
		),
		headReadBytes: captured.items.reduce(
			(sum, item) =>
				sum +
				documentBytes({ ...compactHead(item), _id: item._id, _creationTime: item._creationTime }),
			0
		),
		baselineId,
		items: captured.items.map((item) => ({
			itemId: item._id,
			revisionId: item.currentRevisionId!
		}))
	};
	const versionId = await writeTemplateVersion(ctx, pointer, captured.baseline, version);
	await ctx.scheduler.runAfter(0, internal.authoringValidation.certify, { companyId, versionId });
	if (!company.baselineId) {
		await assertStorageCapacity(ctx, {
			documents: 1,
			bytes: documentBytes({ ...company, baselineId })
		});
		await ctx.db.patch('company', companyId, { baselineId });
	}
	return versionId;
}

type TemplateVersionContent = Omit<Doc<'templateVersions'>, '_id' | '_creationTime' | 'mutability'>;

/** Complete native read/result envelope, independent of the mutation's remaining write budget. */
export function templateReadCapacity(version: TemplateVersionContent, baseline: Doc<'baselines'>) {
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
		throw templateRejected('Contract snapshot exceeds supported read capacity.');
	// Revision/chunk wrappers exceed the historical projection's native size. The
	// 64 KiB reserve also covers the result's four fields and parent/access reads.
	return versionBytes;
}

/** Compact facts + all live heads + metadata, with room for changed head/body reads. */
export function authoringReadCapacity(
	version: TemplateVersionContent,
	baseline: Doc<'baselines'>,
	certificate: Doc<'baselineAuthoring'> | null
) {
	if (!certificate) return;
	if (
		!Number.isSafeInteger(version.headReadBytes) ||
		version.headReadBytes! < 0 ||
		!Number.isSafeInteger(version.structureResultBytes) ||
		version.structureResultBytes! < 0 ||
		version.structureResultBytes! + 65_536 > 16 * 1024 * 1024 ||
		version.headReadBytes! +
			certificate.readBytes +
			documentBytes(certificate) +
			documentBytes(version) +
			documentBytes(baseline) +
			2_100_000 >
			16 * 1024 * 1024 ||
		certificate.chunkCount + version.itemCount + 96 > 32_000
	)
		throw templateRejected('Template structure exceeds supported read capacity.');
}

export async function writeTemplateVersion(
	ctx: MutationCtx,
	pointer: Doc<'currentTemplate'> | null,
	baseline: Doc<'baselines'>,
	version: TemplateVersionContent,
	structuralChanged = true,
	knownCertificate?: Doc<'baselineAuthoring'>
) {
	const certificate =
		knownCertificate ?? (await readValidationCertificate(ctx, baseline.companyId, baseline._id));
	const current = pointer ? await ctx.db.get('templateVersions', pointer.versionId) : null;
	if (pointer && (!current || current.companyId !== version.companyId))
		throw templateRejected('The baseline contract is not available.');
	const authoringGeneration =
		(pointer?.authoringGeneration ?? current?.authoringGeneration ?? 0) + 1;
	const structuralGeneration =
		(pointer?.structuralGeneration ?? current?.structuralGeneration ?? 0) +
		Number(structuralChanged);
	if (
		![authoringGeneration, structuralGeneration].every(
			(value) => Number.isSafeInteger(value) && value >= 0
		)
	)
		throw templateRejected('The authoring generation is invalid.');
	const stored = {
		...version,
		authoringGeneration,
		structuralGeneration,
		...(validationCertified(baseline, certificate)
			? { validation: { format: VALIDATION_CODEC_VERSION, fingerprint: baseline.fingerprint } }
			: {}),
		mutability: 'mutable' as const
	};
	const nextPointer = {
		companyId: version.companyId,
		versionId: current?._id as Id<'templateVersions'>,
		authoringGeneration,
		structuralGeneration
	};
	authoringReadCapacity(stored, baseline, certificate);
	const bytes = templateReadCapacity(stored, baseline);
	await assertStorageCapacity(ctx, { documents: 1, bytes });
	// Mutable versions have no captured contracts. First capture freezes them;
	// replacing a mutable version preserves its ID and current pointer.
	if (pointer && current?.mutability === 'mutable') {
		await ctx.db.replace('templateVersions', current._id, stored);
		await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(nextPointer) });
		await ctx.db.replace('currentTemplate', pointer._id, nextPointer);
		return current._id;
	}
	const versionId = await ctx.db.insert('templateVersions', stored);
	nextPointer.versionId = versionId;
	await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(nextPointer) });
	if (pointer) await ctx.db.replace('currentTemplate', pointer._id, nextPointer);
	else await ctx.db.insert('currentTemplate', nextPointer);
	return versionId;
}

/** Late revision marking and its owning total remain in the template save transaction. */
export async function addTemplateReadBytes(
	ctx: MutationCtx,
	versionId: Id<'templateVersions'>,
	baseline: Doc<'baselines'>,
	delta: number
) {
	if (delta === 0) return;
	const version = await ctx.db.get('templateVersions', versionId);
	if (
		!version ||
		version.companyId !== baseline.companyId ||
		version.baselineId !== baseline._id ||
		version.mutability !== 'mutable'
	)
		throw templateRejected('The baseline contract is not available.');
	const contentReadBytes = version.contentReadBytes + delta;
	const bytes = templateReadCapacity({ ...version, contentReadBytes }, baseline);
	await assertStorageCapacity(ctx, { documents: 1, bytes });
	await ctx.db.patch('templateVersions', versionId, { contentReadBytes });
}

export function isMutableTemplateVersion(version: Doc<'templateVersions'> | null) {
	return Boolean(version?.mutability === 'mutable');
}

/** Audited metadata, independent of baseline prose and unrelated instruction bodies. */
export async function readAuthoringVersion(
	ctx: QueryCtx,
	company: Doc<'company'>,
	current?: DetailRecord
) {
	if (company.authoringMigration)
		throw templateRejected(
			'Template authoring is temporarily unavailable while its data is upgraded.'
		);
	const pointer = await currentPointer(ctx, company._id);
	if (!pointer || !company.baselineId)
		throw templateRejected('The baseline contract is not available.');
	const [version, baseline, certificate] = await Promise.all([
		ctx.db.get('templateVersions', pointer.versionId),
		ctx.db.get('baselines', company.baselineId),
		readValidationCertificate(ctx, company._id, company.baselineId)
	]);
	if (
		!version ||
		version.companyId !== company._id ||
		version.baselineId !== company.baselineId ||
		!baseline ||
		baseline.companyId !== company._id ||
		baseline.state !== 'active' ||
		baseline.blockCount !== version.blockCount
	)
		throw templateRejected('The baseline contract is not available.');
	if (
		pointer.authoringGeneration !== version.authoringGeneration ||
		pointer.structuralGeneration !== version.structuralGeneration ||
		!validationCertified(baseline, certificate, version)
	)
		throw templateRejected('The template needs authoring certification.');
	const references = versionReferences(version);
	if (
		current &&
		(!current.currentRevisionId ||
			references.get(current._id)?.revisionId !== current.currentRevisionId)
	)
		throw templateRejected('The saved rule revision is missing.');
	return { pointer, version, baseline, certificate: certificate! };
}
/** The ordered unchanged manifest remains certified; only the changed body contributes a delta. */
export async function saveChangedVersion(
	ctx: MutationCtx,
	captured: Awaited<ReturnType<typeof readAuthoringVersion>>,
	previous: DetailRecord | null,
	next: DetailRecord | null,
	revisionBytes: { previous: number; next: number },
	structuralChanged: boolean,
	headBytes: { previous: number; next: number }
) {
	const { pointer, version, baseline } = captured;
	const id = previous?._id ?? next?._id;
	const references = versionReferences(version);
	if (
		!id ||
		(previous && next && previous._id !== next._id) ||
		(previous
			? references.get(id)?.revisionId !== previous.currentRevisionId
			: references.has(id)) ||
		[next, previous].some((item) => item && item.companyId !== version.companyId) ||
		Object.values(revisionBytes).some((bytes) => !Number.isSafeInteger(bytes) || bytes < 0)
	)
		throw templateRejected('The saved rule revision is missing.');
	const items = previous
		? version.items.flatMap((reference) =>
				reference.itemId === id
					? next
						? [{ itemId: id, revisionId: next.currentRevisionId! }]
						: []
					: [reference]
			)
		: [...version.items, { itemId: id, revisionId: next!.currentRevisionId! }];
	const jsonBytes = (item: HistoricalItem | null) =>
		item ? new TextEncoder().encode(JSON.stringify(snapshotItem(item))).byteLength : 0;
	// Creating/deleting changes array punctuation only when another member exists.
	const punctuation = !previous
		? Number(version.itemCount > 0)
		: !next
			? -Number(version.itemCount > 1)
			: 0;
	return writeTemplateVersion(
		ctx,
		pointer,
		baseline,
		{
			companyId: version.companyId,
			baselineId: version.baselineId,
			updatedAt: Date.now(),
			blockCount: version.blockCount,
			itemCount: items.length,
			snapshotBytes: version.snapshotBytes + jsonBytes(next) - jsonBytes(previous) + punctuation,
			contentReadBytes: version.contentReadBytes + revisionBytes.next - revisionBytes.previous,
			headReadBytes: (version.headReadBytes ?? 0) + headBytes.next - headBytes.previous,
			structureResultBytes:
				(version.structureResultBytes ?? 0) +
				(next ? getConvexSize(itemStructure(next)) : 0) -
				(previous ? getConvexSize(itemStructure(previous)) : 0),
			items
		},
		structuralChanged,
		captured.certificate
	);
}
/** Compatibility list reads the manifest directly, without a full-head scan plus body joins. */
export async function currentDetails(ctx: QueryCtx, companyId: Id<'company'>) {
	const pointer = await currentPointer(ctx, companyId);
	if (!pointer) return [];
	const version = await ctx.db.get('templateVersions', pointer.versionId);
	if (!version || version.companyId !== companyId)
		throw new ConvexError('This template version is unavailable.');
	versionReferences(version);
	const baseline = await ctx.db.get('baselines', version.baselineId);
	if (
		!baseline ||
		baseline.companyId !== companyId ||
		version.contentReadBytes < baseline.chunkReadBytes ||
		version.contentReadBytes -
			baseline.chunkReadBytes +
			documentBytes(version) +
			documentBytes(baseline) +
			version.itemCount * 128 +
			65_536 >
			16 * 1024 * 1024 ||
		version.itemCount + 4 + 64 > 4096
	)
		throw new ConvexError('The playbook list exceeds supported read capacity.');
	const items: DetailRecord[] = [];
	for (let offset = 0; offset < version.items.length; offset += 64) {
		const batch = version.items.slice(offset, offset + 64);
		const revisions = await Promise.all(
			batch.map((ref) => ctx.db.get('playbookItemRevisions', ref.revisionId))
		);
		for (const [i, revision] of revisions.entries()) {
			if (
				!revision ||
				revision.companyId !== companyId ||
				revision.itemId !== batch[i].itemId ||
				!Number.isSafeInteger(revision.contentRevision) ||
				revision.contentRevision < 1
			)
				throw new ConvexError('This template version is incomplete.');
			items.push(liveRevision(revision));
		}
	}
	return items;
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
export const content = query({
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
export async function versionReader(
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
		readItems,
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
export const setCompanyContract = mutation({
	args: {
		membershipId: v.id('memberships'),
		preparedBaselineId: v.id('baselines')
	},
	returns: v.id('templateVersions'),
	handler: async (ctx, { membershipId, preparedBaselineId }) => {
		const access = await requirePermission(ctx, 'manageTemplate', membershipId);
		const baseline = await ctx.db.get('baselines', preparedBaselineId);
		if (
			!baseline ||
			baseline.companyId !== access.companyId ||
			baseline.source !== 'docx' ||
			baseline.uploaderId !== access.profile._id ||
			baseline.state === 'deleting'
		)
			throw templateRejected('This upload is unavailable. Select the DOCX again.');
		if (baseline.issues.some((issue) => issue.severity === 'error'))
			throw templateRejected('Resolve the document conversion errors before saving.');
		const pointer = await currentPointer(ctx, access.companyId);
		const currentBaseline = access.company.baselineId
			? await ctx.db.get('baselines', access.company.baselineId)
			: null;
		if (
			pointer &&
			currentBaseline?.state === 'active' &&
			currentBaseline._id === baseline._id &&
			baseline.state === 'active'
		)
			return pointer.versionId;
		if (baseline.state !== 'prepared' || !baseline.expiresAt || baseline.expiresAt <= Date.now())
			throw templateRejected('This upload has expired. Select the DOCX again.');
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
			throw templateRejected(
				'This company already has a baseline or an import in progress. Its baseline cannot be replaced.'
			);
		let blocks: BaselineBlock[];
		try {
			const parsed = await readBaseline(ctx, preparedBaselineId, access.companyId, baseline);
			blocks = parsed.blocks;
		} catch (error) {
			if (error instanceof BaselineFingerprintError)
				throw templateRejected('The prepared document failed validation. Select the DOCX again.');
			throw error;
		}
		const { expiresAt, ...source } = baseline;
		const active: Doc<'baselines'> = {
			...source,
			state: 'active',
			activatedAt: Date.now()
		};
		await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(active) });
		const { _id, _creationTime, ...stored } = active;
		await ctx.db.replace('baselines', preparedBaselineId, stored);
		return saveTemplateVersion(
			ctx,
			access.companyId,
			{
				pointer: null,
				baseline: active,
				blocks,
				items: []
			},
			access.company
		);
	}
});

type VersionReference = Doc<'templateVersions'>['items'][number];
export function versionReferences(version: Doc<'templateVersions'>) {
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
/** Database creation-order ties never define the business manifest order. */
export function orderedHeads(
	version: Doc<'templateVersions'>,
	heads: Doc<'playbookItems'>[],
	normalized = true
) {
	versionReferences(version);
	const byId = new Map(heads.map((head) => [head._id, head]));
	if (heads.length !== version.itemCount || byId.size !== heads.length)
		throw templateRejected('The saved rule revision is missing.');
	return version.items.map((reference) => {
		const head = byId.get(reference.itemId);
		if (
			!head ||
			head.companyId !== version.companyId ||
			head.currentRevisionId !== reference.revisionId ||
			(normalized && !('format' in head))
		)
			throw templateRejected('The saved rule revision is missing.');
		return head;
	});
}
async function resolveVersionItem(
	ctx: QueryCtx,
	version: Doc<'templateVersions'>,
	reference: VersionReference
): Promise<HistoricalItem> {
	const contentRevision = await ctx.db.get('playbookItemRevisions', reference.revisionId);
	if (
		!contentRevision ||
		contentRevision.companyId !== version.companyId ||
		contentRevision.itemId !== reference.itemId ||
		!Number.isSafeInteger(contentRevision.contentRevision) ||
		contentRevision.contentRevision < 1 ||
		!Number.isFinite(contentRevision.itemCreatedAt) ||
		contentRevision.itemCreatedAt < 0
	)
		throw new ConvexError('This template version is incomplete.');
	return historicalRevision(contentRevision);
}

export { version } from './legacyTemplates';
