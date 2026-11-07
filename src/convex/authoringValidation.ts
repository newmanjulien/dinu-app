import { validateBaseline } from '../lib/contract/validate-source';
import {
	certifyValidationFacts,
	decodeValidationFacts,
	VALIDATION_CODEC_VERSION
} from '../lib/contract/validation-codec';
import { validateReferenceFacts } from '../lib/contract/validation-source';
import type { BaselineBlock } from '../lib/contract/source-model';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import { v } from 'convex/values';
import { requireCompany } from './auth';
import { readBaseline } from './baselineStorage';
import { authoringReadCapacity, currentPointer, templateReadCapacity } from './templates';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { templateRejected } from './templateCapacity';

const CHUNK_BYTES = 768 * 1024;
export function readValidationCertificate(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	baselineId: Id<'baselines'>
) {
	return ctx.db
		.query('baselineAuthoring')
		.withIndex('by_companyId_and_baselineId', (q) =>
			q.eq('companyId', companyId).eq('baselineId', baselineId)
		)
		.unique();
}
/** Bulk acceptance only. Certified once against the fully validated source. */
export async function writeValidationFacts(
	ctx: MutationCtx,
	args: {
		companyId: Id<'company'>;
		baselineId: Id<'baselines'>;
		fingerprint: string;
		blocks: readonly BaselineBlock[];
	}
) {
	const data = certifyValidationFacts(validateBaseline(args.blocks).index);
	const chunks = Math.ceil(data.byteLength / CHUNK_BYTES);
	const baseline = await ctx.db.get('baselines', args.baselineId);
	if (!baseline || baseline.companyId !== args.companyId)
		throw templateRejected('Source validation storage is unavailable.');
	const existing = await readValidationCertificate(ctx, args.companyId, args.baselineId);
	const old = existing?.chunkIds ?? [];
	const chunkIds: Id<'baselineValidationChunks'>[] = [];
	let readBytes = 0;
	for (let order = 0; order < chunks; order++) {
		const row = {
			companyId: args.companyId,
			baselineId: args.baselineId,
			order,
			data: data.slice(order * CHUNK_BYTES, (order + 1) * CHUNK_BYTES)
		};
		await assertStorageCapacity(ctx, {
			documents: 1,
			bytes: documentBytes(row),
			queries: 1,
			readDocuments: 1
		});
		let id: Id<'baselineValidationChunks'>;
		if (old[order]) {
			id = old[order];
			await ctx.db.replace('baselineValidationChunks', id, row);
		} else id = await ctx.db.insert('baselineValidationChunks', row);
		chunkIds.push(id);
		readBytes += documentBytes({ ...row, _id: id, _creationTime: 0 });
	}
	for (const row of old.slice(chunks)) {
		await assertStorageCapacity(ctx, { documents: 1 });
		await ctx.db.delete('baselineValidationChunks', row);
	}
	const certificate = {
		companyId: args.companyId,
		baselineId: args.baselineId,
		format: VALIDATION_CODEC_VERSION,
		fingerprint: args.fingerprint,
		chunkCount: chunks,
		chunkIds,
		dataBytes: data.byteLength,
		readBytes
	};
	await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(certificate) });
	if (existing) {
		await ctx.db.replace('baselineAuthoring', existing._id, certificate);
		return { ...certificate, _id: existing._id, _creationTime: existing._creationTime };
	}
	const id = await ctx.db.insert('baselineAuthoring', certificate);
	return { ...certificate, _id: id, _creationTime: 0 };
}

export function validationCertified(
	baseline: Doc<'baselines'>,
	facts: Doc<'baselineAuthoring'> | null,
	version?: Doc<'templateVersions'>
) {
	return Boolean(
		facts &&
		facts.companyId === baseline.companyId &&
		facts.baselineId === baseline._id &&
		facts.format === VALIDATION_CODEC_VERSION &&
		facts.fingerprint === baseline.fingerprint &&
		Number.isSafeInteger(facts.chunkCount) &&
		facts.chunkCount > 0 &&
		facts.chunkCount <= 4096 &&
		facts.chunkIds.length === facts.chunkCount &&
		Number.isSafeInteger(facts.dataBytes) &&
		facts.dataBytes > 0 &&
		Number.isSafeInteger(facts.readBytes) &&
		facts.readBytes > 0 &&
		(!version ||
			(version.validation?.format === VALIDATION_CODEC_VERSION &&
				version.validation.fingerprint === baseline.fingerprint &&
				Number.isSafeInteger(version.headReadBytes) &&
				version.headReadBytes! >= 0 &&
				Number.isSafeInteger(version.structureResultBytes) &&
				version.structureResultBytes! >= 0))
	);
}

/** No source prose, canonical serialization or hashing occurs on ordinary saves. */
export async function readValidationFacts(
	ctx: QueryCtx,
	baseline: Doc<'baselines'>,
	knownCertificate?: Doc<'baselineAuthoring'>
) {
	const certificate =
		knownCertificate ?? (await readValidationCertificate(ctx, baseline.companyId, baseline._id));
	if (!validationCertified(baseline, certificate))
		throw templateRejected('The baseline needs authoring certification.');
	const facts = certificate!;
	const rows = await ctx.db
		.query('baselineValidationChunks')
		.withIndex('by_companyId_and_baselineId_and_order', (q) =>
			q.eq('companyId', baseline.companyId).eq('baselineId', baseline._id)
		)
		.take(facts.chunkCount + 1);
	const bytes = new Uint8Array(facts.dataBytes);
	let cursor = 0,
		readBytes = 0;
	for (const [order, row] of rows.entries()) {
		if (
			row.order !== order ||
			row._id !== facts.chunkIds[order] ||
			row.baselineId !== baseline._id ||
			row.companyId !== baseline.companyId ||
			cursor + row.data.byteLength > bytes.length
		)
			throw templateRejected('Source validation storage is incomplete.');
		bytes.set(new Uint8Array(row.data), cursor);
		cursor += row.data.byteLength;
		readBytes += documentBytes(row);
	}
	if (rows.length !== facts.chunkCount || cursor !== bytes.length || readBytes !== facts.readBytes)
		throw templateRejected('Source validation storage is incomplete.');
	const decoded = decodeValidationFacts(bytes.buffer);
	if (decoded.index.orderedBlocks.length !== baseline.blockCount)
		throw templateRejected('Source validation storage is incomplete.');
	return {
		index: decoded.index,
		validateReference: (ref: Parameters<typeof validateReferenceFacts>[1]) =>
			validateReferenceFacts(decoded.references, ref)
	};
}

/** One-time source persistence is separate from the native source/import write budget. */
export const certify = internalMutation({
	args: { companyId: v.id('company'), versionId: v.id('templateVersions') },
	returns: v.null(),
	handler: async (ctx, { companyId, versionId }) => {
		const company = await requireCompany(ctx, companyId),
			pointer = await currentPointer(ctx, companyId);
		if (company.authoringMigration || pointer?.versionId !== versionId || !company.baselineId)
			return null;
		const version = await ctx.db.get('templateVersions', versionId),
			baseline = await ctx.db.get('baselines', company.baselineId);
		if (
			!version ||
			!baseline ||
			version.companyId !== companyId ||
			baseline.companyId !== companyId ||
			version.baselineId !== baseline._id ||
			baseline.state !== 'active'
		)
			return null;
		let certificate = await readValidationCertificate(ctx, companyId, baseline._id);
		if (validationCertified(baseline, certificate, version)) return null;
		// Only the canonical bulk writer supplies this full-source/body audit proof.
		// Legacy/repair data must pass the complete scoped migration instead.
		if (version.validation?.format !== 0 || version.validation.fingerprint !== baseline.fingerprint)
			return null;
		if (!validationCertified(baseline, certificate)) {
			const source = await readBaseline(ctx, baseline._id, companyId, baseline);
			certificate = await writeValidationFacts(ctx, {
				companyId,
				baselineId: baseline._id,
				fingerprint: baseline.fingerprint,
				blocks: source.blocks
			});
		}
		authoringReadCapacity(version, baseline, certificate);
		templateReadCapacity(version, baseline);
		const next = {
			...version,
			validation: { format: VALIDATION_CODEC_VERSION, fingerprint: baseline.fingerprint }
		};
		await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(next) });
		await ctx.db.patch('templateVersions', versionId, { validation: next.validation });
		return null;
	}
});
