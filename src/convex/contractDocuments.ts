import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ConvexError, getConvexSize } from 'convex/values';
import type { ContractDocument, PieceLineage } from '../lib/document/contract-document';
import {
	contractDocumentToRenderTransport,
	documentIndex
} from '../lib/document/contract-document';
import { canonicalJson } from '../lib/document/canonical-json';
import { validateStorageArrays } from '../lib/document/storage-limits';
import { PlaybookValidationError } from '../lib/playbook/validation-error';
import type { SourceBlock } from '../lib/document/source-model';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { MAX_SNAPSHOT_BYTES } from './templateCapacity';
import { DiscussionPreparationRequired } from './discussionMaps';
import { requireNativeReachability } from './nativeStage';
import { requireLiveDocumentOwner } from './contractDocumentLifetime';

const CHUNK_BYTES = 128 * 1024;
const MIN_CHUNK_BYTES = 16 * 1024;
const MAX_CHUNKS = 512;
const RESERVE_BYTES = 65_536;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const fingerprint = (data: Uint8Array) => bytesToHex(sha256(data));
type Scope = { companyId: Id<'company'>; contractId: Id<'savedContracts'> };
type PlannedChunk = { data: ArrayBuffer; fingerprint: string };
type DocumentRecord = { block: SourceBlock; pieces: PieceLineage[] };
const unavailable = () => new ConvexError('This contract document is unavailable.');

/** Admit the native render shape, never the private arrays serialized into chunk bytes. */
export function assertContractDocumentRenderCapacity(document: ContractDocument): void {
	const transport = contractDocumentToRenderTransport(document);
	try {
		validateStorageArrays(transport);
	} catch (error) {
		if (error instanceof PlaybookValidationError)
			throw new ConvexError('This contract exceeds supported document capacity.');
		throw error;
	}
}

/** Paragraph-key boundaries keep later chunks reusable after an insertion or a local edit. */
export function planContractDocumentChunks(document: ContractDocument): PlannedChunk[] {
	documentIndex(document);
	assertContractDocumentRenderCapacity(document);
	if (getConvexSize(document.blocks) > MAX_SNAPSHOT_BYTES)
		throw new ConvexError('This contract exceeds supported document capacity.');
	const pieces = new Map(document.pieces.map((piece) => [piece.sourceKey, piece]));
	if (pieces.size !== document.pieces.length) throw new Error('Duplicate contract piece lineage.');
	const records = document.blocks.map((block) => {
		const content = block.kind === 'table' ? [] : block.content;
		const lineage = content.map((atom) => {
			const piece = pieces.get(atom.sourceKey);
			if (
				!piece ||
				piece.origin.end - piece.origin.start !== (atom.kind === 'text' ? atom.text.length : 1)
			)
				throw new Error('Contract piece lineage is incomplete.');
			pieces.delete(atom.sourceKey);
			return piece;
		});
		return {
			key: block.blockKey,
			data: encoder.encode(canonicalJson({ block: { ...block, order: 0 }, pieces: lineage }) + '\n')
		};
	});
	if (pieces.size) throw new Error('Contract piece lineage contains retired content.');
	const chunks: PlannedChunk[] = [];
	const add = (data: Uint8Array) =>
		chunks.push({ data: data.slice().buffer as ArrayBuffer, fingerprint: fingerprint(data) });
	// Independent metadata does not force an unchanged paragraph chunk to be rewritten.
	const metadata = encoder.encode(
		canonicalJson({
			aliases: document.aliases,
			removedBlocks: document.removedBlocks,
			...(document.annotationEffects ? { annotationEffects: document.annotationEffects } : {})
		}) + '\n'
	);
	for (let offset = 0; offset < metadata.byteLength; offset += CHUNK_BYTES)
		add(metadata.subarray(offset, offset + CHUNK_BYTES));
	let pending: Uint8Array[] = [],
		pendingBytes = 0;
	const flush = () => {
		if (!pendingBytes) return;
		const data = new Uint8Array(pendingBytes);
		let offset = 0;
		for (const part of pending) {
			data.set(part, offset);
			offset += part.byteLength;
		}
		add(data);
		pending = [];
		pendingBytes = 0;
	};
	for (const record of records) {
		if (
			pendingBytes &&
			(pendingBytes + record.data.byteLength > CHUNK_BYTES ||
				(pendingBytes >= MIN_CHUNK_BYTES && sha256(encoder.encode(record.key))[0] % 16 === 0))
		)
			flush();
		if (record.data.byteLength > CHUNK_BYTES) {
			for (let offset = 0; offset < record.data.byteLength; offset += CHUNK_BYTES)
				add(record.data.subarray(offset, offset + CHUNK_BYTES));
		} else {
			pending.push(record.data);
			pendingBytes += record.data.byteLength;
		}
	}
	flush();
	if (
		chunks.length > MAX_CHUNKS ||
		chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0) + RESERVE_BYTES > MAX_READ_BYTES
	)
		throw new ConvexError('This contract exceeds supported document capacity.');
	return chunks;
}
export function assertContractDocumentManifest(
	manifest: Doc<'contractDocuments'> | null,
	scope?: Scope
): asserts manifest is Doc<'contractDocuments'> {
	if (
		!manifest ||
		(scope && (manifest.companyId !== scope.companyId || manifest.contractId !== scope.contractId))
	)
		throw unavailable();
	if (
		manifest.format !== 1 ||
		!manifest.chunkIds.length ||
		manifest.chunkIds.length > MAX_CHUNKS ||
		manifest.chunkIds.length !== manifest.chunkHashes.length ||
		manifest.readBytes + RESERVE_BYTES > MAX_READ_BYTES
	)
		throw unavailable();
}

/** Callers authorize the owning contract before loading its private lineage. */
export async function readContractDocument(
	ctx: QueryCtx,
	documentId: Id<'contractDocuments'>,
	scope?: Scope,
	options: {
		deferOnCapacity?: boolean;
		currentView?: { documentId: Id<'contractDocuments'>; documentFingerprint: string };
	} = {}
): Promise<ContractDocument> {
	const manifest = await ctx.db.get('contractDocuments', documentId);
	assertContractDocumentManifest(manifest, scope);
	// Only an atomically published, live-authorized pointer can establish public
	// reachability without subscribing to its private preparation receipt.
	if (options.currentView) {
		if (
			options.currentView.documentId !== documentId ||
			options.currentView.documentFingerprint !== manifest.fingerprint ||
			(manifest.stage && !manifest.stage.sealed)
		)
			throw unavailable();
	} else await requireNativeReachability(ctx, 'contractDocuments', documentId, manifest);
	const metrics = await ctx.meta.getTransactionMetrics();
	if (
		metrics.bytesRead.remaining <
			manifest.readBytes + (options.deferOnCapacity ? 1_000_000 : RESERVE_BYTES) ||
		metrics.databaseQueries.remaining <
			manifest.chunkIds.length + (options.deferOnCapacity ? 48 : 0) ||
		metrics.documentsRead.remaining < manifest.chunkIds.length + (options.deferOnCapacity ? 48 : 0)
	) {
		if (options.deferOnCapacity) throw new DiscussionPreparationRequired('capacity');
		throw new ConvexError('This contract exceeds the remaining document read capacity.');
	}
	const rows = await Promise.all(
		manifest.chunkIds.map((id) => ctx.db.get('contractDocumentChunks', id))
	);
	return decodeContractDocumentChunks(manifest, rows);
}

/** Shared integrity decoder for bounded action page reads and ordinary immutable reads. */
export function decodeContractDocumentChunks(
	manifest: Doc<'contractDocuments'>,
	rows: (Doc<'contractDocumentChunks'> | null)[]
): ContractDocument {
	assertContractDocumentManifest(manifest);
	if (
		rows.length !== manifest.chunkIds.length ||
		rows.some((row, index) => !row || row._id !== manifest.chunkIds[index])
	)
		throw unavailable();
	let dataBytes = 0,
		readBytes = 0,
		nativeBytes = 0;
	const chunks: Uint8Array[] = [];
	for (const [index, row] of rows.entries()) {
		if (
			!row ||
			row.companyId !== manifest.companyId ||
			row.contractId !== manifest.contractId ||
			row.fingerprint !== manifest.chunkHashes[index]
		)
			throw unavailable();
		const data = new Uint8Array(row.data);
		if (fingerprint(data) !== row.fingerprint) throw unavailable();
		dataBytes += data.byteLength;
		readBytes += documentBytes(row);
		nativeBytes += documentBytes(row);
		chunks.push(data);
	}
	if (
		nativeBytes + RESERVE_BYTES > MAX_READ_BYTES ||
		dataBytes !== manifest.dataBytes ||
		readBytes !== manifest.readBytes ||
		fingerprint(encoder.encode(JSON.stringify(manifest.chunkHashes))) !== manifest.fingerprint
	)
		throw unavailable();
	const data = new Uint8Array(dataBytes);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const lines = decoder.decode(data).trimEnd().split('\n');
	const metadata = JSON.parse(lines[0]) as Pick<
		ContractDocument,
		'aliases' | 'removedBlocks' | 'annotationEffects'
	>;
	const records = lines.slice(1).map((line) => JSON.parse(line) as DocumentRecord);
	const document: ContractDocument = {
		...metadata,
		blocks: records.map((record, order) => ({ ...record.block, order })),
		pieces: records.flatMap((record) => record.pieces)
	};
	if (document.blocks.length !== manifest.blockCount) throw unavailable();
	documentIndex(document);
	return document;
}

export type PreparedContractDocument = {
	scope: Scope;
	chunks: PlannedChunk[];
	hashes: string[];
	fingerprint: string;
	reusable: Map<string, Id<'contractDocumentChunks'>>;
	existingId?: Id<'contractDocuments'>;
	dataBytes: number;
	readBytes: number;
	blockCount: number;
	work: { documents: number; bytes: number };
};
/** Encode and measure once, before the native engine's first business write. */
export async function prepareContractDocument(
	ctx: QueryCtx,
	args: Scope & { document: ContractDocument; previousDocumentId?: Id<'contractDocuments'> }
): Promise<PreparedContractDocument> {
	await requireLiveDocumentOwner(ctx, args);
	const chunks = planContractDocumentChunks(args.document),
		hashes = chunks.map((chunk) => chunk.fingerprint),
		documentFingerprint = fingerprint(encoder.encode(JSON.stringify(hashes)));
	const old = args.previousDocumentId
		? await ctx.db.get('contractDocuments', args.previousDocumentId)
		: null;
	if (args.previousDocumentId) assertContractDocumentManifest(old, args);
	const reusable = new Map(
			old?.chunkHashes.map((hash, index) => [hash, old.chunkIds[index]]) ?? []
		),
		scope = { companyId: args.companyId, contractId: args.contractId },
		measure = (chunk: PlannedChunk) =>
			documentBytes({ ...scope, ...chunk, _id: 'x'.repeat(32), _creationTime: 0 });
	const dataBytes = chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0),
		readBytes = chunks.reduce((sum, chunk) => sum + measure(chunk), 0);
	const manifest = {
		...scope,
		format: 1,
		fingerprint: documentFingerprint,
		chunkIds: chunks.map((chunk) => reusable.get(chunk.fingerprint) ?? 'x'.repeat(32)),
		chunkHashes: hashes,
		dataBytes,
		readBytes,
		blockCount: args.document.blocks.length
	};
	const manifestBytes = documentBytes(manifest);
	if (readBytes + manifestBytes + RESERVE_BYTES > MAX_READ_BYTES)
		throw new ConvexError('This contract exceeds supported document read capacity.');
	const unique = new Map(
		chunks
			.filter((chunk) => !reusable.has(chunk.fingerprint))
			.map((chunk) => [chunk.fingerprint, chunk])
	);
	return {
		scope,
		chunks,
		hashes,
		fingerprint: documentFingerprint,
		reusable,
		...(old?.fingerprint === documentFingerprint ? { existingId: old._id } : {}),
		dataBytes,
		readBytes,
		blockCount: args.document.blocks.length,
		work:
			old?.fingerprint === documentFingerprint
				? { documents: 0, bytes: 0 }
				: {
						documents: unique.size + 1,
						bytes:
							[...unique.values()].reduce((sum, chunk) => sum + measure(chunk), 0) + manifestBytes
					}
	};
}
/** This consumes an admitted plan: no encoding, source reads or late capacity checks. */
export async function commitContractDocument(
	ctx: MutationCtx,
	plan: PreparedContractDocument
): Promise<Id<'contractDocuments'>> {
	if (plan.existingId) return plan.existingId;
	const chunkIds: Id<'contractDocumentChunks'>[] = [];
	for (const chunk of plan.chunks) {
		let id = plan.reusable.get(chunk.fingerprint);
		if (!id) {
			id = await ctx.db.insert('contractDocumentChunks', { ...plan.scope, ...chunk });
			plan.reusable.set(chunk.fingerprint, id);
		}
		chunkIds.push(id);
	}
	return ctx.db.insert('contractDocuments', {
		...plan.scope,
		format: 1,
		fingerprint: plan.fingerprint,
		chunkIds,
		chunkHashes: plan.hashes,
		dataBytes: plan.dataBytes,
		readBytes: plan.readBytes,
		blockCount: plan.blockCount
	});
}
/** Standalone creation keeps the same encode/measure/write path. */
export async function writeContractDocument(
	ctx: MutationCtx,
	args: Scope & { document: ContractDocument; previousDocumentId?: Id<'contractDocuments'> }
): Promise<Id<'contractDocuments'>> {
	const plan = await prepareContractDocument(ctx, args);
	if (plan.existingId) return plan.existingId;
	await assertStorageCapacity(ctx, plan.work);
	return commitContractDocument(ctx, plan);
}
