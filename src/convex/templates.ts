import { isRepItem } from '../lib/playbook/model';
import { ConvexError, v, getConvexSize } from 'convex/values';
import { buildSourceIndex } from '../lib/document/source-index';
import type { SourceBlock } from '../lib/document/source-model';
import type { ValidationSourceFacts } from '../lib/document/validation-source';
import { validatePlaybook } from '../lib/playbook/audit';
import {
	MAX_DOCUMENT_BLOCKS,
	MAX_PLAYBOOK_ITEMS,
	PlaybookValidationError
} from '../lib/playbook/validation';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { query, type MutationCtx, type QueryCtx } from './_generated/server';
import { requireCompany, requireMembership } from './auth';
import { resolveSetupBooking } from './csmSetupState';
import { retireCompanySetupAppointments } from './csmSetupLifecycle';
import {
	templateSourceBlocks,
	TemplateSourceFingerprintError,
	readTemplateSource,
	canonicalFingerprint
} from './templateSourceStorage';
import {
	businessItem,
	hydrateHead,
	compactHead,
	historicalRevision,
	snapshotItem,
	type HistoricalItem
} from './playbookItemRevisions';
import { templateContent } from './templateValidators';
import { itemStructure, type TemplateDetailRecord } from '../lib/playbook/structure';
import {
	validationCertified,
	readValidationCertificate,
	readValidationFacts
} from './authoringValidation';
import { VALIDATION_CODEC_VERSION } from '../lib/document/validation-codec';

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
	templateSource: Doc<'templateSources'>;
	blocks: SourceBlock[];
	items: TemplateDetailRecord[];
};
export async function readLiveSnapshot(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	knownPointer?: Doc<'currentTemplate'> | null,
	knownCompany?: Doc<'company'>
): Promise<LiveSnapshot> {
	const pointer = knownPointer === undefined ? await currentPointer(ctx, companyId) : knownPointer;
	const company = knownCompany ?? (await ctx.db.get('company', companyId));
	if (!pointer || pointer.companyId !== companyId || !company?.templateSourceId)
		throw templateRejected('The template is not available.');
	const [source, items, version] = await Promise.all([
		readTemplateSource(ctx, company.templateSourceId, companyId),
		ctx.db
			.query('playbookItems')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(MAX_PLAYBOOK_ITEMS + 1),
		ctx.db.get('templateVersions', pointer.versionId)
	]);
	const records = source.blocks;
	if (!records.length) throw templateRejected('The template is not available.');
	if (records.length > MAX_DOCUMENT_BLOCKS || items.length > MAX_PLAYBOOK_ITEMS)
		throw templateRejected('Template exceeds supported size.');
	if (
		!version ||
		version.companyId !== companyId ||
		version.templateSourceId !== source.templateSource._id
	)
		throw templateRejected('The template version is missing.');
	const ordered = orderedHeads(version, items);
	return {
		pointer,
		templateSource: source.templateSource,
		blocks: records,
		items: await Promise.all(ordered.map((item) => hydrateHead(ctx, item)))
	};
}

async function snapshotCapacity(ctx: MutationCtx, captured: LiveSnapshot) {
	const { blocks, items, templateSource } = captured;
	const historical = items.map(snapshotItem);
	const snapshotBytes = new TextEncoder().encode(
		JSON.stringify({ blocks, items: historical })
	).byteLength;
	if (
		!blocks.length ||
		blocks.length > MAX_DOCUMENT_BLOCKS ||
		items.length > MAX_PLAYBOOK_ITEMS ||
		snapshotBytes > MAX_SNAPSHOT_BYTES
	)
		throw templateRejected('Template snapshot exceeds supported size.');
	let contentReadBytes = templateSource.chunkReadBytes;
	// Initial/bulk saves have no prior proof. Count every actual stored wrapper.
	for (let offset = 0; offset < items.length; offset += 64) {
		const batch = items.slice(offset, offset + 64);
		await assertStorageCapacity(ctx, { queries: batch.length, readDocuments: batch.length });
		const revisions = await Promise.all(
			batch.map((item) => ctx.db.get('playbookItemRevisions', item.currentRevisionId))
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
	const pointer = captured.pointer;
	const templateSourceId = captured.templateSource._id;
	const company = knownCompany ?? (await ctx.db.get('company', companyId));
	if (
		!company ||
		company._id !== companyId ||
		(pointer !== null && pointer.companyId !== companyId) ||
		captured.templateSource.companyId !== companyId ||
		captured.templateSource.state !== 'active' ||
		(company.templateSourceId !== undefined && company.templateSourceId !== templateSourceId)
	)
		throw templateRejected('The template is not available.');
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
		validation: { format: 0 as const, fingerprint: captured.templateSource.fingerprint },
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
		templateSourceId,
		items: captured.items.map((item) => ({
			itemId: item._id,
			revisionId: item.currentRevisionId,
			audience: item.audience
		}))
	};
	const versionId = await writeTemplateVersion(ctx, pointer, captured.templateSource, version);
	await ctx.scheduler.runAfter(0, internal.authoringValidation.certify, { companyId, versionId });
	if (!company.templateSourceId) {
		await assertStorageCapacity(ctx, {
			documents: 1,
			bytes: documentBytes({ ...company, templateSourceId })
		});
		await ctx.db.patch('company', companyId, { templateSourceId });
		await retireCompanySetupAppointments(ctx, companyId);
	}
	return versionId;
}

type TemplateVersionContent = Omit<
	Doc<'templateVersions'>,
	'_id' | '_creationTime' | 'mutability' | 'authoringGeneration' | 'structuralGeneration'
>;

function generation(value: number) {
	if (!Number.isSafeInteger(value) || value < 0)
		throw templateRejected('The authoring generation is invalid.');
	return value;
}
/** Manifest clocks own canonical state. */
export function templateGenerations(version: Doc<'templateVersions'> | null) {
	return {
		authoringGeneration: generation(version ? version.authoringGeneration : 0),
		structuralGeneration: generation(version ? version.structuralGeneration : 0)
	};
}
export function nextTemplateGenerations(
	version: Doc<'templateVersions'> | null,
	structuralChanged = true
) {
	const current = templateGenerations(version);
	return {
		authoringGeneration: generation(current.authoringGeneration + 1),
		structuralGeneration: generation(current.structuralGeneration + Number(structuralChanged))
	};
}

/** Complete native read/result envelope, independent of the mutation's remaining write budget. */
export function templateReadCapacity(
	version: TemplateVersionContent,
	templateSource: Doc<'templateSources'>
) {
	const versionBytes = documentBytes(version);
	if (
		!Number.isSafeInteger(version.snapshotBytes) ||
		version.snapshotBytes < 0 ||
		version.snapshotBytes > MAX_SNAPSHOT_BYTES ||
		!Number.isSafeInteger(version.contentReadBytes) ||
		version.contentReadBytes < 0 ||
		version.contentReadBytes + versionBytes + documentBytes(templateSource) + 65_536 >
			16 * 1024 * 1024 ||
		// Revisions use individual gets; all chunks use one indexed query.
		version.itemCount + 3 + 64 > 4096 ||
		version.itemCount + templateSource.chunkCount + 2 + 64 > 32_000
	)
		throw templateRejected('Template snapshot exceeds supported read capacity.');
	// Revision/chunk wrappers exceed the historical projection's native size. The
	// 64 KiB reserve also covers the result's four fields and parent/access reads.
	return versionBytes;
}

/** Compact facts + all live heads + metadata, with room for changed head/body reads. */
export function authoringReadCapacity(
	version: TemplateVersionContent,
	templateSource: Doc<'templateSources'>,
	certificate: Doc<'templateSourceCertificates'> | null
) {
	if (!certificate) return;
	if (
		!Number.isSafeInteger(version.headReadBytes) ||
		version.headReadBytes < 0 ||
		!Number.isSafeInteger(version.structureResultBytes) ||
		version.structureResultBytes < 0 ||
		// The fixed source identity and readiness/watermark envelope fit this reserve.
		version.structureResultBytes + 65_536 > 16 * 1024 * 1024 ||
		version.headReadBytes +
			certificate.readBytes +
			documentBytes(certificate) +
			documentBytes(version) +
			documentBytes(templateSource) +
			2_100_000 >
			16 * 1024 * 1024 ||
		certificate.chunkCount + version.itemCount + 96 > 32_000
	)
		throw templateRejected('Template structure exceeds supported read capacity.');
}

export async function writeTemplateVersion(
	ctx: MutationCtx,
	pointer: Doc<'currentTemplate'> | null,
	templateSource: Doc<'templateSources'>,
	version: TemplateVersionContent,
	structuralChanged = true,
	knownCertificate?: Doc<'templateSourceCertificates'>
) {
	const certificate =
		knownCertificate ??
		(await readValidationCertificate(ctx, templateSource.companyId, templateSource._id));
	const current = pointer ? await ctx.db.get('templateVersions', pointer.versionId) : null;
	if (
		templateSource.companyId !== version.companyId ||
		templateSource._id !== version.templateSourceId ||
		(pointer &&
			(pointer.companyId !== version.companyId ||
				!current ||
				current.companyId !== version.companyId ||
				current.templateSourceId !== templateSource._id))
	)
		throw templateRejected('The template is not available.');
	const { authoringGeneration, structuralGeneration } = nextTemplateGenerations(
		current,
		structuralChanged
	);
	const stored = {
		...version,
		authoringGeneration,
		structuralGeneration,
		validation: validationCertified(templateSource, certificate)
			? ({ format: VALIDATION_CODEC_VERSION, fingerprint: templateSource.fingerprint } as const)
			: version.validation,
		mutability: 'mutable' as const
	};
	authoringReadCapacity(stored, templateSource, certificate);
	const bytes = templateReadCapacity(stored, templateSource);
	await assertStorageCapacity(ctx, { documents: 1, bytes });
	// Mutable versions have no captured contracts. First capture freezes them;
	// replacing a mutable version preserves its ID and current pointer.
	if (pointer && current?.mutability === 'mutable') {
		await ctx.db.replace('templateVersions', current._id, stored);
		return current._id;
	}
	const versionId = await ctx.db.insert('templateVersions', stored);
	const nextPointer = { companyId: version.companyId, versionId };
	await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(nextPointer) });
	if (pointer) await ctx.db.replace('currentTemplate', pointer._id, nextPointer);
	else await ctx.db.insert('currentTemplate', nextPointer);
	return versionId;
}

/** Late revision marking and its owning total remain in the template save transaction. */
export async function addTemplateReadBytes(
	ctx: MutationCtx,
	versionId: Id<'templateVersions'>,
	templateSource: Doc<'templateSources'>,
	delta: number
) {
	if (delta === 0) return;
	const version = await ctx.db.get('templateVersions', versionId);
	if (
		!version ||
		version.companyId !== templateSource.companyId ||
		version.templateSourceId !== templateSource._id ||
		version.mutability !== 'mutable'
	)
		throw templateRejected('The template is not available.');
	const contentReadBytes = version.contentReadBytes + delta;
	const bytes = templateReadCapacity({ ...version, contentReadBytes }, templateSource);
	await assertStorageCapacity(ctx, { documents: 1, bytes });
	await ctx.db.patch('templateVersions', versionId, { contentReadBytes });
}

export function isMutableTemplateVersion(version: Doc<'templateVersions'> | null) {
	return Boolean(version?.mutability === 'mutable');
}

/** Audited metadata, independent of template source prose and unrelated item bodies. */
export async function readAuthoringVersion(
	ctx: QueryCtx,
	company: Doc<'company'>,
	current?: TemplateDetailRecord
) {
	const pointer = await currentPointer(ctx, company._id);
	if (!pointer || !company.templateSourceId)
		throw templateRejected('The template is not available.');
	const [version, templateSource, certificate] = await Promise.all([
		ctx.db.get('templateVersions', pointer.versionId),
		ctx.db.get('templateSources', company.templateSourceId),
		readValidationCertificate(ctx, company._id, company.templateSourceId)
	]);
	if (
		!version ||
		version.companyId !== company._id ||
		version.templateSourceId !== company.templateSourceId ||
		!templateSource ||
		templateSource.companyId !== company._id ||
		templateSource.state !== 'active' ||
		templateSource.blockCount !== version.blockCount
	)
		throw templateRejected('The template is not available.');
	templateGenerations(version);
	if (!validationCertified(templateSource, certificate, version))
		throw templateRejected('The template needs authoring certification.');
	const references = versionReferences(version);
	if (current && references.get(current._id)?.revisionId !== current.currentRevisionId)
		throw templateRejected('The saved rule revision is missing.');
	return { pointer, version, templateSource, certificate: certificate! };
}
/** The ordered unchanged manifest remains certified; only the changed body contributes a delta. */
export async function saveChangedVersion(
	ctx: MutationCtx,
	captured: Awaited<ReturnType<typeof readAuthoringVersion>>,
	previous: TemplateDetailRecord | null,
	next: TemplateDetailRecord | null,
	revisionBytes: { previous: number; next: number },
	structuralChanged: boolean,
	headBytes: { previous: number; next: number }
) {
	const { pointer, version, templateSource } = captured;
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
						? [{ itemId: id, revisionId: next.currentRevisionId, audience: next.audience }]
						: []
					: [reference]
			)
		: [
				...version.items,
				{ itemId: id, revisionId: next!.currentRevisionId, audience: next!.audience }
			];
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
		templateSource,
		{
			companyId: version.companyId,
			templateSourceId: version.templateSourceId,
			updatedAt: Date.now(),
			blockCount: version.blockCount,
			itemCount: items.length,
			snapshotBytes: version.snapshotBytes + jsonBytes(next) - jsonBytes(previous) + punctuation,
			contentReadBytes: version.contentReadBytes + revisionBytes.next - revisionBytes.previous,
			headReadBytes: version.headReadBytes + headBytes.next - headBytes.previous,
			structureResultBytes:
				version.structureResultBytes +
				(next ? getConvexSize(itemStructure(next)) : 0) -
				(previous ? getConvexSize(itemStructure(previous)) : 0),
			validation: {
				format: VALIDATION_CODEC_VERSION,
				fingerprint: templateSource.fingerprint
			},
			items
		},
		structuralChanged,
		captured.certificate
	);
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
	returns: templateContent,
	handler: async (ctx, { versionId, membershipId }) => {
		const { companyId } = await requireMembership(ctx, membershipId);
		return readVersion(ctx, versionId, companyId);
	}
});
/** Current authoring content is reactive and must never enter the frozen snapshot cache. */
export const preview = query({
	args: { membershipId: v.id('memberships') },
	returns: v.union(v.null(), templateContent),
	handler: async (ctx, { membershipId }) => {
		const { companyId } = await requireMembership(ctx, membershipId);
		const pointer = await currentPointer(ctx, companyId);
		return pointer ? readVersion(ctx, pointer.versionId, companyId) : null;
	}
});
export const frozenContent = query({
	args: { membershipId: v.id('memberships'), versionId: v.id('templateVersions') },
	returns: templateContent,
	handler: async (ctx, { versionId, membershipId }) => {
		const { companyId } = await requireMembership(ctx, membershipId);
		return (await versionReader(ctx, versionId, companyId, true)).read();
	}
});
// Callers authorize the company or contract first. Validate the immutable parent
// once per transaction; use its counts for every complete read.
export function snapshotReader(
	ctx: QueryCtx,
	contract: Pick<Doc<'savedContracts'>, 'templateVersionId' | 'companyId'>
) {
	return versionReader(ctx, contract.templateVersionId, contract.companyId, true);
}
export async function versionReader(
	ctx: QueryCtx,
	versionId: Id<'templateVersions'>,
	companyId: Id<'company'>,
	requireFrozen = false
) {
	const storedVersion = await ctx.db.get('templateVersions', versionId);
	if (!storedVersion || storedVersion.companyId !== companyId)
		throw new ConvexError('This template version is unavailable.');
	if (requireFrozen && storedVersion.mutability !== 'frozen')
		throw new ConvexError('This template version has not been captured.');
	const version = storedVersion;
	const { blockCount, itemCount, templateSourceId } = version;
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
	async function readItemsByIds(ids: readonly Id<'playbookItems'>[]) {
		const unique = [...new Set(ids)];
		const result: HistoricalItem[] = [];
		for (let offset = 0; offset < unique.length; offset += 64) {
			const rows = await Promise.all(unique.slice(offset, offset + 64).map(item));
			for (const row of rows) if (row) result.push(row);
		}
		return result;
	}
	async function readBuyerExplanations() {
		const refs = version.items.filter((ref) => ref.audience === 'buyer');
		const items: Extract<HistoricalItem, { audience: 'buyer' }>[] = [];
		for (let offset = 0; offset < refs.length; offset += 64) {
			const rows = await Promise.all(refs.slice(offset, offset + 64).map(resolve));
			for (const row of rows) if (row.audience === 'buyer') items.push(row);
		}
		return items;
	}
	async function blocks() {
		const result = await templateSourceBlocks(ctx, templateSourceId, companyId);
		if (result.length !== blockCount) throw new ConvexError('This template version is incomplete.');
		return result;
	}
	let sourceFactsPromise: Promise<ValidationSourceFacts> | undefined;
	function readSourceFacts(): Promise<ValidationSourceFacts> {
		return (sourceFactsPromise ??= (async () => {
			const [templateSource, certificate] = await Promise.all([
				ctx.db.get('templateSources', templateSourceId),
				readValidationCertificate(ctx, companyId, templateSourceId)
			]);
			if (
				templateSource &&
				templateSource.companyId === companyId &&
				validationCertified(templateSource, certificate)
			) {
				return (await readValidationFacts(ctx, templateSource, certificate!)).index;
			}
			return buildSourceIndex(await blocks());
		})());
	}
	return {
		readBytes: version.contentReadBytes + documentBytes(version),
		blocks,
		readSourceFacts,
		item,
		readItems,
		readItemsByIds,
		readBuyerExplanations,
		async read() {
			const [snapshotBlocks, items] = await Promise.all([blocks(), readItems()]);
			return { blockCount, itemCount, blocks: snapshotBlocks, items };
		}
	};
}

/** Project only the active concession changes needed by effective-view and export wire payloads. */
export async function readAppliedOverlays(
	reader: Pick<Awaited<ReturnType<typeof versionReader>>, 'readItemsByIds'>,
	concessions: Readonly<Record<string, string>>
) {
	const appliedIds = Object.keys(concessions) as Id<'playbookItems'>[];
	const appliedItems = appliedIds.length > 0 ? await reader.readItemsByIds(appliedIds) : [];
	return appliedItems.flatMap((item) => {
		if (!isRepItem(item)) return [];
		const optionId = concessions[item._id];
		const concession = item.concessions.find((c) => c.id === optionId);
		if (!concession) return [];
		return [
			{
				itemId: item._id,
				trigger: item.trigger,
				concessions: [{ id: concession.id, changes: concession.changes }]
			}
		];
	});
}

/** Trusted release reuses the canonical version/bootstrap path in one transaction. */
export async function activatePendingTemplate(
	ctx: MutationCtx,
	args: {
		companyId: Id<'company'>;
		pendingTemplateSourceId: Id<'templateSources'>;
		expectedFingerprint: string;
	}
): Promise<Id<'templateVersions'>> {
	const { companyId, pendingTemplateSourceId, expectedFingerprint } = args;
	const company = await requireCompany(ctx, companyId);
	const templateSource = await ctx.db.get('templateSources', pendingTemplateSourceId);
	if (
		!templateSource ||
		templateSource.companyId !== companyId ||
		templateSource.source !== 'docx' ||
		templateSource.fingerprint !== expectedFingerprint ||
		templateSource.state === 'deleting'
	)
		throw templateRejected(
			'This exact pending upload is unavailable or has changed. Inspect it again.'
		);
	const pointer = await currentPointer(ctx, companyId);
	// Lost-response replay precedes booking admission: later cancellation cannot undo a release.
	if (
		company.templateSourceId === templateSource._id &&
		templateSource.state === 'active' &&
		pointer
	) {
		const version = await ctx.db.get('templateVersions', pointer.versionId);
		if (version?.companyId === companyId && version.templateSourceId === templateSource._id)
			return version._id;
		throw templateRejected('The released template version is unavailable.');
	}
	if (company.pendingTemplateSourceId !== templateSource._id || templateSource.state !== 'pending')
		throw templateRejected(
			'This upload is no longer the current pending template. Inspect it again.'
		);
	if (!Number.isFinite(templateSource.expiresAt) || templateSource.expiresAt <= Date.now())
		throw templateRejected('This upload has expired. Upload the DOCX again.');
	if ((await resolveSetupBooking(ctx, company)).kind !== 'confirmed')
		throw templateRejected('A confirmed setup call is required before releasing this template.');
	if (templateSource.issues.some((issue) => issue.severity === 'error'))
		throw templateRejected('Resolve the document conversion errors before releasing.');
	const [items, versions, active, revisions, receipts] = await Promise.all([
		ctx.db
			.query('playbookItems')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(1),
		ctx.db
			.query('templateVersions')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(1),
		ctx.db
			.query('templateSources')
			.withIndex('by_companyId_and_state', (q) =>
				q.eq('companyId', companyId).eq('state', 'active')
			)
			.first(),
		ctx.db
			.query('playbookItemRevisions')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(1),
		ctx.db
			.query('playbookItemCreationReceipts')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(1)
	]);
	if (
		company.templateSourceId ||
		pointer ||
		active ||
		items.length ||
		versions.length ||
		revisions.length ||
		receipts.length
	)
		throw templateRejected(
			'This company already has template data. Its template source cannot be replaced.'
		);
	let blocks: SourceBlock[];
	try {
		const parsed = await readTemplateSource(
			ctx,
			pendingTemplateSourceId,
			companyId,
			templateSource
		);
		blocks = parsed.blocks;
	} catch (error) {
		if (error instanceof TemplateSourceFingerprintError)
			throw templateRejected('The pending document failed validation. Upload the DOCX again.');
		throw error;
	}
	const { expiresAt, ...source } = templateSource;
	const activeSource: Doc<'templateSources'> = {
		...source,
		state: 'active',
		activatedAt: Date.now()
	};
	await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(activeSource) });
	const { _id, _creationTime, ...stored } = activeSource;
	await ctx.db.replace('templateSources', pendingTemplateSourceId, stored);
	const versionId = await saveTemplateVersion(
		ctx,
		companyId,
		{
			pointer: null,
			templateSource: activeSource,
			blocks,
			items: []
		},
		company
	);
	await ctx.db.patch('company', companyId, { pendingTemplateSourceId: undefined });
	return versionId;
}

type VersionReference = Doc<'templateVersions'>['items'][number];
export function versionReferences(version: Doc<'templateVersions'>) {
	const { blockCount, itemCount } = version;
	const references = new Map(version.items.map((item) => [item.itemId, item]));
	if (
		!Number.isSafeInteger(blockCount) ||
		blockCount < 1 ||
		blockCount > MAX_DOCUMENT_BLOCKS ||
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
export function orderedHeads(version: Doc<'templateVersions'>, heads: Doc<'playbookItems'>[]) {
	versionReferences(version);
	const byId = new Map(heads.map((head) => [head._id, head]));
	if (heads.length !== version.itemCount || byId.size !== heads.length)
		throw templateRejected('The saved rule revision is missing.');
	return version.items.map((reference) => {
		const head = byId.get(reference.itemId);
		if (
			!head ||
			head.companyId !== version.companyId ||
			head.audience !== reference.audience ||
			head.currentRevisionId !== reference.revisionId
		)
			throw templateRejected('The saved rule revision is missing.');
		return head;
	});
}
export function orderedAudienceHeads(
	version: Doc<'templateVersions'>,
	audience: Doc<'playbookItems'>['audience'],
	heads: Doc<'playbookItems'>[]
) {
	versionReferences(version);
	const expected = version.items.filter((reference) => reference.audience === audience);
	const byId = new Map(heads.map((head) => [head._id, head]));
	if (heads.length !== expected.length || byId.size !== heads.length)
		throw templateRejected('The saved rule revision is missing.');
	return expected.map((reference) => {
		const head = byId.get(reference.itemId);
		if (
			!head ||
			head.companyId !== version.companyId ||
			head.audience !== audience ||
			head.currentRevisionId !== reference.revisionId
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
