import { validateDocumentSource } from '../lib/document/validate-source';
import {
	certifyValidationFacts,
	decodeValidationFacts,
	VALIDATION_CODEC_VERSION
} from '../lib/document/validation-codec';
import { validateReferenceFacts } from '../lib/document/validation-source';
import type { SourceBlock } from '../lib/document/source-model';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import { v } from 'convex/values';
import { requireCompany } from './auth';
import { readTemplateSource } from './templateSourceStorage';
import { authoringReadCapacity, currentPointer, templateReadCapacity } from './templates';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { templateRejected } from './templateCapacity';

const CHUNK_BYTES = 768 * 1024;
export function readValidationCertificate(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	templateSourceId: Id<'templateSources'>
) {
	return ctx.db
		.query('templateSourceCertificates')
		.withIndex('by_companyId_and_templateSourceId', (q) =>
			q.eq('companyId', companyId).eq('templateSourceId', templateSourceId)
		)
		.unique();
}
/** Bulk acceptance only. Certified once against the fully validated source. */
export async function writeValidationFacts(
	ctx: MutationCtx,
	args: {
		companyId: Id<'company'>;
		templateSourceId: Id<'templateSources'>;
		fingerprint: string;
		blocks: readonly SourceBlock[];
	}
) {
	const data = certifyValidationFacts(validateDocumentSource(args.blocks).index);
	const chunks = Math.ceil(data.byteLength / CHUNK_BYTES);
	const templateSource = await ctx.db.get('templateSources', args.templateSourceId);
	if (!templateSource || templateSource.companyId !== args.companyId)
		throw templateRejected('Source validation storage is unavailable.');
	const existing = await readValidationCertificate(ctx, args.companyId, args.templateSourceId);
	const old = existing?.chunkIds ?? [];
	const chunkIds: Id<'templateSourceValidationChunks'>[] = [];
	let readBytes = 0;
	for (let order = 0; order < chunks; order++) {
		const row = {
			companyId: args.companyId,
			templateSourceId: args.templateSourceId,
			order,
			data: data.slice(order * CHUNK_BYTES, (order + 1) * CHUNK_BYTES)
		};
		await assertStorageCapacity(ctx, {
			documents: 1,
			bytes: documentBytes(row),
			queries: 1,
			readDocuments: 1
		});
		let id: Id<'templateSourceValidationChunks'>;
		if (old[order]) {
			id = old[order];
			await ctx.db.replace('templateSourceValidationChunks', id, row);
		} else id = await ctx.db.insert('templateSourceValidationChunks', row);
		chunkIds.push(id);
		readBytes += documentBytes({ ...row, _id: id, _creationTime: 0 });
	}
	for (const row of old.slice(chunks)) {
		await assertStorageCapacity(ctx, { documents: 1 });
		await ctx.db.delete('templateSourceValidationChunks', row);
	}
	const certificate = {
		companyId: args.companyId,
		templateSourceId: args.templateSourceId,
		format: VALIDATION_CODEC_VERSION,
		fingerprint: args.fingerprint,
		chunkCount: chunks,
		chunkIds,
		dataBytes: data.byteLength,
		readBytes
	};
	await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(certificate) });
	if (existing) {
		await ctx.db.replace('templateSourceCertificates', existing._id, certificate);
		return { ...certificate, _id: existing._id, _creationTime: existing._creationTime };
	}
	const id = await ctx.db.insert('templateSourceCertificates', certificate);
	return { ...certificate, _id: id, _creationTime: 0 };
}

export function validationCertified(
	templateSource: Doc<'templateSources'>,
	facts: Doc<'templateSourceCertificates'> | null,
	version?: Doc<'templateVersions'>
) {
	return Boolean(
		facts &&
		facts.companyId === templateSource.companyId &&
		facts.templateSourceId === templateSource._id &&
		facts.format === VALIDATION_CODEC_VERSION &&
		facts.fingerprint === templateSource.fingerprint &&
		Number.isSafeInteger(facts.chunkCount) &&
		facts.chunkCount > 0 &&
		facts.chunkCount <= 4096 &&
		facts.chunkIds.length === facts.chunkCount &&
		Number.isSafeInteger(facts.dataBytes) &&
		facts.dataBytes > 0 &&
		Number.isSafeInteger(facts.readBytes) &&
		facts.readBytes > 0 &&
		(!version ||
			(version.validation.format === VALIDATION_CODEC_VERSION &&
				version.validation.fingerprint === templateSource.fingerprint &&
				Number.isSafeInteger(version.headReadBytes) &&
				version.headReadBytes >= 0 &&
				Number.isSafeInteger(version.structureResultBytes) &&
				version.structureResultBytes >= 0))
	);
}

/** No source prose, canonical serialization or hashing occurs on ordinary saves. */
export async function readValidationFacts(
	ctx: QueryCtx,
	templateSource: Doc<'templateSources'>,
	certificate: Doc<'templateSourceCertificates'>
) {
	if (!validationCertified(templateSource, certificate))
		throw templateRejected('The template source needs authoring certification.');
	const rows = await ctx.db
		.query('templateSourceValidationChunks')
		.withIndex('by_companyId_and_templateSourceId_and_order', (q) =>
			q.eq('companyId', templateSource.companyId).eq('templateSourceId', templateSource._id)
		)
		.take(certificate.chunkCount + 1);
	const bytes = new Uint8Array(certificate.dataBytes);
	let cursor = 0,
		readBytes = 0;
	for (const [order, row] of rows.entries()) {
		if (
			row.order !== order ||
			row._id !== certificate.chunkIds[order] ||
			row.templateSourceId !== templateSource._id ||
			row.companyId !== templateSource.companyId ||
			cursor + row.data.byteLength > bytes.length
		)
			throw templateRejected('Source validation storage is incomplete.');
		bytes.set(new Uint8Array(row.data), cursor);
		cursor += row.data.byteLength;
		readBytes += documentBytes(row);
	}
	if (
		rows.length !== certificate.chunkCount ||
		cursor !== bytes.length ||
		readBytes !== certificate.readBytes
	)
		throw templateRejected('Source validation storage is incomplete.');
	const decoded = decodeValidationFacts(bytes.buffer);
	if (decoded.index.orderedBlocks.length !== templateSource.blockCount)
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
		if (pointer?.versionId !== versionId || !company.templateSourceId) return null;
		const version = await ctx.db.get('templateVersions', versionId),
			templateSource = await ctx.db.get('templateSources', company.templateSourceId);
		if (
			!version ||
			!templateSource ||
			version.companyId !== companyId ||
			templateSource.companyId !== companyId ||
			version.templateSourceId !== templateSource._id ||
			templateSource.state !== 'active'
		)
			return null;
		let certificate = await readValidationCertificate(ctx, companyId, templateSource._id);
		if (validationCertified(templateSource, certificate, version)) return null;
		// Only the canonical bulk writer supplies this full-source/body audit proof.
		if (
			version.validation.format !== 0 ||
			version.validation.fingerprint !== templateSource.fingerprint
		)
			return null;
		if (!validationCertified(templateSource, certificate)) {
			const source = await readTemplateSource(ctx, templateSource._id, companyId, templateSource);
			certificate = await writeValidationFacts(ctx, {
				companyId,
				templateSourceId: templateSource._id,
				fingerprint: templateSource.fingerprint,
				blocks: source.blocks
			});
		}
		authoringReadCapacity(version, templateSource, certificate);
		templateReadCapacity(version, templateSource);
		const validation = {
			format: VALIDATION_CODEC_VERSION,
			fingerprint: templateSource.fingerprint
		} as const;
		const next = { ...version, validation };
		await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(next) });
		await ctx.db.patch('templateVersions', versionId, { validation });
		return null;
	}
});
