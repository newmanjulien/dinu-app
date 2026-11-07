import { sha256 } from '@noble/hashes/sha2.js';
import { ConvexError, getConvexSize, getDocumentSize } from 'convex/values';
import type { BaselineBlock } from '../lib/contract/source-model';
import { MAX_STORAGE_DOCUMENT_BYTES } from '../lib/contract/storage-limits';
import { MAX_CONTRACT_BLOCKS } from '../lib/playbook/validation';
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
export function baselineIntegrity(blocks: readonly BaselineBlock[]) {
	const bytes = canonicalBytes(blocks);
	return { fingerprint: fingerprint(bytes), blocksJsonBytes: bytes.byteLength };
}

export class BaselineFingerprintError extends ConvexError<string> {
	constructor() {
		super('This baseline is incomplete.');
	}
}

export const BASELINE_CHUNK_TARGET_BYTES = 768 * 1024;
const measurementId = 'x'.repeat(32);
type Chunk = Omit<Doc<'baselineChunks'>, '_id' | '_creationTime'>;

/** Pack whole source blocks; source keys, order and inline content remain untouched. */
export function planBaselineChunks(args: {
	companyId: Id<'company'>;
	baselineId: Id<'baselines'>;
	blocks: readonly BaselineBlock[];
}): Chunk[] {
	if (!args.blocks.length || args.blocks.length > MAX_CONTRACT_BLOCKS)
		throw templateRejected('Contract exceeds supported size.');
	const chunks: Chunk[] = [];
	let firstBlock = 0;
	let blocks: BaselineBlock[] = [];
	const row = (blocks: BaselineBlock[]): Chunk => ({
		companyId: args.companyId,
		baselineId: args.baselineId,
		order: chunks.length,
		firstBlock,
		blocks
	});
	const wrapperBytes = getDocumentSize({ ...row([]), _id: measurementId, _creationTime: 0 });
	let bytes = wrapperBytes;
	for (const block of args.blocks) {
		const blockBytes = getConvexSize(block);
		if (blocks.length && bytes + blockBytes > BASELINE_CHUNK_TARGET_BYTES) {
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

/** The caller allocates the baseline, then patches these final counters atomically. */
export async function writeBaselineChunks(
	ctx: MutationCtx,
	args: {
		companyId: Id<'company'>;
		baselineId: Id<'baselines'>;
		blocks: readonly BaselineBlock[];
	}
) {
	const chunks = planBaselineChunks(args);
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
		const id = await ctx.db.insert('baselineChunks', chunk);
		const saved = (await ctx.db.get('baselineChunks', id))!;
		chunkReadBytes += documentBytes(saved);
	}

	return {
		chunkCount: chunks.length,
		chunkReadBytes
	};
}
export async function readBaselineMetadata(
	ctx: QueryCtx,
	baselineId: Id<'baselines'>,
	companyId: Id<'company'>,
	knownBaseline?: Doc<'baselines'>
) {
	const baseline = knownBaseline ?? (await ctx.db.get('baselines', baselineId));
	if (
		!baseline ||
		baseline._id !== baselineId ||
		baseline.companyId !== companyId ||
		baseline.state === 'deleting'
	)
		throw new ConvexError('This baseline is unavailable.');
	const counts = [
		baseline.blockCount,
		baseline.chunkCount,
		baseline.blocksJsonBytes,
		baseline.chunkReadBytes
	];
	if (
		counts.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
		baseline.blockCount > MAX_CONTRACT_BLOCKS ||
		baseline.chunkCount > baseline.blockCount ||
		baseline.chunkReadBytes + 65_536 > 16 * 1024 * 1024
	)
		throw new ConvexError('This baseline is incomplete.');
	return baseline;
}

export async function readBaseline(
	ctx: QueryCtx,
	baselineId: Id<'baselines'>,
	companyId: Id<'company'>,
	knownBaseline?: Doc<'baselines'>
) {
	const baseline = await readBaselineMetadata(ctx, baselineId, companyId, knownBaseline);
	const rows = await ctx.db
		.query('baselineChunks')
		.withIndex('by_companyId_and_baselineId_and_order', (q) =>
			q.eq('companyId', companyId).eq('baselineId', baselineId)
		)
		.take(baseline.chunkCount + 1);
	const blocks: BaselineBlock[] = [];
	let chunkReadBytes = 0;
	for (const [ordinal, row] of rows.entries()) {
		if (
			row.companyId !== companyId ||
			row.baselineId !== baselineId ||
			row.order !== ordinal ||
			row.firstBlock !== blocks.length ||
			!row.blocks.length ||
			blocks.length + row.blocks.length > baseline.blockCount
		)
			throw new ConvexError('This baseline is incomplete.');
		blocks.push(...row.blocks);
		chunkReadBytes += documentBytes(row);
	}
	if (
		rows.length !== baseline.chunkCount ||
		blocks.length !== baseline.blockCount ||
		chunkReadBytes !== baseline.chunkReadBytes
	)
		throw new ConvexError('This baseline is incomplete.');
	const integrity = baselineIntegrity(blocks);
	if (integrity.blocksJsonBytes !== baseline.blocksJsonBytes)
		throw new ConvexError('This baseline is incomplete.');
	if (integrity.fingerprint !== baseline.fingerprint) throw new BaselineFingerprintError();
	return { baseline, blocks, chunks: rows };
}

export async function baselineBlocks(
	ctx: QueryCtx,
	baselineId: Id<'baselines'>,
	companyId: Id<'company'>,
	knownBaseline?: Doc<'baselines'>
) {
	return (await readBaseline(ctx, baselineId, companyId, knownBaseline)).blocks;
}
