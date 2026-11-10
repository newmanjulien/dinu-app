import { sha256 } from '@noble/hashes/sha2.js';
import { ConvexError, getConvexSize, getDocumentSize } from 'convex/values';
import type { SourceBlock } from '../lib/document/source-model';
import { MAX_STORAGE_DOCUMENT_BYTES } from '../lib/document/storage-limits';
import { MAX_DOCUMENT_BLOCKS } from '../lib/playbook/validation';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { templateRejected } from './templateCapacity';

/** Canonical JSON for plain source/business values; array order remains significant. */
function canonicalBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify(value, (_key, value) =>
			value && typeof value === 'object' && !Array.isArray(value)
				? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
				: value
		)
	);
}
function fingerprint(bytes: Uint8Array): string {
	return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function canonicalFingerprint(value: unknown): string {
	return fingerprint(canonicalBytes(value));
}
export function templateSourceIntegrity(blocks: readonly SourceBlock[]) {
	const bytes = canonicalBytes(blocks);
	return { fingerprint: fingerprint(bytes), blocksJsonBytes: bytes.byteLength };
}

export class TemplateSourceFingerprintError extends ConvexError<string> {
	constructor() {
		super('This template source is incomplete.');
	}
}

export const TEMPLATE_SOURCE_CHUNK_TARGET_BYTES = 768 * 1024;
const measurementId = 'x'.repeat(32);
type Chunk = Omit<Doc<'templateSourceChunks'>, '_id' | '_creationTime'>;

/** Pack whole source blocks; source keys, order and inline content remain untouched. */
export function planTemplateSourceChunks(args: {
	companyId: Id<'company'>;
	templateSourceId: Id<'templateSources'>;
	blocks: readonly SourceBlock[];
}): Chunk[] {
	if (!args.blocks.length || args.blocks.length > MAX_DOCUMENT_BLOCKS)
		throw templateRejected('Template exceeds supported size.');
	const chunks: Chunk[] = [];
	let firstBlock = 0;
	let blocks: SourceBlock[] = [];
	const row = (blocks: SourceBlock[]): Chunk => ({
		companyId: args.companyId,
		templateSourceId: args.templateSourceId,
		order: chunks.length,
		firstBlock,
		blocks
	});
	const wrapperBytes = getDocumentSize({ ...row([]), _id: measurementId, _creationTime: 0 });
	let bytes = wrapperBytes;
	for (const block of args.blocks) {
		const blockBytes = getConvexSize(block);
		if (blocks.length && bytes + blockBytes > TEMPLATE_SOURCE_CHUNK_TARGET_BYTES) {
			chunks.push(row(blocks));
			firstBlock += blocks.length;
			blocks = [];
			bytes = wrapperBytes;
		}
		blocks.push(block);
		bytes += blockBytes;
		// A valid large block may use a chunk of its own, up to the native document cap.
		if (bytes > MAX_STORAGE_DOCUMENT_BYTES)
			throw templateRejected('A template storage document exceeds supported size.');
	}
	chunks.push(row(blocks));
	return chunks;
}

/** The caller allocates the templateSource, then patches these final counters atomically. */
export async function writeTemplateSourceChunks(
	ctx: MutationCtx,
	args: {
		companyId: Id<'company'>;
		templateSourceId: Id<'templateSources'>;
		blocks: readonly SourceBlock[];
	}
) {
	const chunks = planTemplateSourceChunks(args);
	const plannedBytes = chunks.reduce(
		(sum, chunk) => sum + documentBytes({ ...chunk, _id: measurementId, _creationTime: 0 }),
		0
	);
	await assertStorageCapacity(ctx, {
		documents: chunks.length,
		bytes: plannedBytes,
		queries: chunks.length,
		readDocuments: chunks.length,
		readBytes: plannedBytes
	});
	let chunkReadBytes = 0;
	for (const chunk of chunks) {
		const id = await ctx.db.insert('templateSourceChunks', chunk);
		const saved = (await ctx.db.get('templateSourceChunks', id))!;
		chunkReadBytes += documentBytes(saved);
	}

	return {
		chunkCount: chunks.length,
		chunkReadBytes
	};
}
export async function readTemplateSourceMetadata(
	ctx: QueryCtx,
	templateSourceId: Id<'templateSources'>,
	companyId: Id<'company'>,
	knownTemplateSource?: Doc<'templateSources'>
) {
	const templateSource =
		knownTemplateSource ?? (await ctx.db.get('templateSources', templateSourceId));
	if (
		!templateSource ||
		templateSource._id !== templateSourceId ||
		templateSource.companyId !== companyId ||
		templateSource.state === 'deleting'
	)
		throw new ConvexError('This template source is unavailable.');
	const counts = [
		templateSource.blockCount,
		templateSource.chunkCount,
		templateSource.blocksJsonBytes,
		templateSource.chunkReadBytes
	];
	if (
		counts.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
		templateSource.blockCount > MAX_DOCUMENT_BLOCKS ||
		templateSource.chunkCount > templateSource.blockCount ||
		templateSource.chunkReadBytes + 65_536 > 16 * 1024 * 1024
	)
		throw new ConvexError('This template source is incomplete.');
	return templateSource;
}

export async function readTemplateSource(
	ctx: QueryCtx,
	templateSourceId: Id<'templateSources'>,
	companyId: Id<'company'>,
	knownTemplateSource?: Doc<'templateSources'>
) {
	const templateSource = await readTemplateSourceMetadata(
		ctx,
		templateSourceId,
		companyId,
		knownTemplateSource
	);
	const rows = await ctx.db
		.query('templateSourceChunks')
		.withIndex('by_companyId_and_templateSourceId_and_order', (q) =>
			q.eq('companyId', companyId).eq('templateSourceId', templateSourceId)
		)
		.take(templateSource.chunkCount + 1);
	const blocks: SourceBlock[] = [];
	let chunkReadBytes = 0;
	for (const [ordinal, row] of rows.entries()) {
		if (
			row.companyId !== companyId ||
			row.templateSourceId !== templateSourceId ||
			row.order !== ordinal ||
			row.firstBlock !== blocks.length ||
			!row.blocks.length ||
			blocks.length + row.blocks.length > templateSource.blockCount
		)
			throw new ConvexError('This template source is incomplete.');
		blocks.push(...row.blocks);
		chunkReadBytes += documentBytes(row);
	}
	if (
		rows.length !== templateSource.chunkCount ||
		blocks.length !== templateSource.blockCount ||
		chunkReadBytes !== templateSource.chunkReadBytes
	)
		throw new ConvexError('This template source is incomplete.');
	const integrity = templateSourceIntegrity(blocks);
	if (integrity.blocksJsonBytes !== templateSource.blocksJsonBytes)
		throw new ConvexError('This template source is incomplete.');
	if (integrity.fingerprint !== templateSource.fingerprint)
		throw new TemplateSourceFingerprintError();
	return { templateSource, blocks, chunks: rows };
}

export async function templateSourceBlocks(
	ctx: QueryCtx,
	templateSourceId: Id<'templateSources'>,
	companyId: Id<'company'>,
	knownTemplateSource?: Doc<'templateSources'>
) {
	return (await readTemplateSource(ctx, templateSourceId, companyId, knownTemplateSource)).blocks;
}
