import { ConvexError, getDocumentSize } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { CompanyAccess } from './auth';
import { cleanupBudget } from './cleanup';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 as hash } from '@noble/hashes/sha2.js';
import { cancelJob } from './emailDeliveries';
import { queueNativeCleanup } from './nativeConstructionCleanup';
import { documentBytes } from './storageCapacity';
import { retireDiscussionMap } from './discussionMaps';
import {
	parseOperationId,
	operationKey,
	OPERATION_FUTURE_TOLERANCE_MS
} from '../lib/contract/operation-identity';

export const receiptChunkFingerprint = (data: string) =>
	bytesToHex(hash(new TextEncoder().encode(data)));

/** Section order is independent of the bounded ordinary payload envelope. */
export const receiptSectionHash = (
	previous: string,
	order: number,
	fingerprint: string,
	records: number
) => receiptChunkFingerprint(JSON.stringify([previous, order, fingerprint, records]));

export function operation(value: string) {
	const parsed = parseOperationId(value);
	if (!parsed)
		throw new ConvexError({ code: 'OPERATION_INVALID', message: 'Invalid operation identity.' });
	return parsed;
}

/** Mutation admission must precede replay, no-op returns and every business write. */
export function admitOperation(value: string) {
	const parsed = operation(value),
		now = Date.now();
	if (parsed.createdAt > now + OPERATION_FUTURE_TOLERANCE_MS)
		throw new ConvexError({
			code: 'OPERATION_FUTURE',
			message: 'The operation clock is ahead. This request made no business writes.'
		});
	if (now >= parsed.retryUntil)
		throw new ConvexError({
			code: 'OPERATION_EXPIRED',
			message: 'This operation expired. Review the preserved intent against the current contract.'
		});
	return parsed;
}

export function receiptDeadline(key: string) {
	const parts: unknown = JSON.parse(key);
	if (!Array.isArray(parts) || parts.length !== 3 || typeof parts[2] !== 'string')
		throw new Error('Invalid operation key.');
	return { ...operation(parts[2]), operationId: parts[2] };
}

/** Mutation-only check; queries expose retryUntil without reading a clock. */
export function operationExpired(row: Pick<Doc<'operationReceipts'>, 'executionUntil'>) {
	return Date.now() >= row.executionUntil;
}

/** Immutable original input/result bytes share the existing inline/chunk envelope. */
export function decodeReceiptPayload<
	T extends {
		companyId: string;
		inputs: string;
		result: string;
		chunked?: boolean;
	}
>(
	row: T,
	chunks: {
		data: string;
		order: number;
		companyId: string;
		fingerprint: string;
		section: string;
		generation: number;
	}[]
) {
	if (!row.chunked) return row;
	if (chunks.length >= 64) throw new Error('Receipt exceeds its storage envelope.');
	if (
		!chunks.length ||
		chunks.some(
			(chunk, order) =>
				chunk.order !== order ||
				chunk.section !== 'payload' ||
				chunk.generation !== 0 ||
				chunk.companyId !== row.companyId ||
				receiptChunkFingerprint(chunk.data) !== chunk.fingerprint
		)
	)
		throw new Error('Receipt chunks are incomplete or have invalid ownership.');
	const decoded: unknown = JSON.parse(chunks.map((c) => c.data).join(''));
	if (
		!Array.isArray(decoded) ||
		decoded.length !== 2 ||
		typeof decoded[0] !== 'string' ||
		typeof decoded[1] !== 'string'
	)
		throw new Error('Receipt payload is invalid.');
	const [inputs, result] = decoded;
	return { ...row, inputs, result };
}

export async function receiptPayload(ctx: QueryCtx, row: Doc<'operationReceipts'>) {
	if (row.collecting)
		throw new ConvexError({
			code: 'OPERATION_EXPIRED',
			message: 'This expired operation is being removed.'
		});
	if (!row.chunked) return row;
	const chunks = await ctx.db
		.query('operationReceiptChunks')
		.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
			q.eq('receiptId', row._id).eq('section', 'payload').eq('generation', 0)
		)
		.take(64);
	return decodeReceiptPayload(row, chunks);
}

/** Callers distinguish preparing, complete and failed before decoding a result. */
export async function receipt(ctx: QueryCtx, key: string, inputs: string) {
	const stored = await ctx.db
		.query('operationReceipts')
		.withIndex('by_key', (q) => q.eq('key', key))
		.unique();
	const row = stored ? await receiptPayload(ctx, stored) : null;
	if (row && row.inputs !== inputs)
		throw new ConvexError('This operation was already used with different inputs.');
	return row;
}

function encodeReceiptPayload(
	companyId: Id<'company'>,
	key: string,
	inputs: string,
	result: string,
	envelopeError = 'Receipt exceeds its storage envelope.'
) {
	const chunked = getDocumentSize({ companyId, key, inputs, result }) > 128 * 1024;
	const payload = {
		inputs: chunked ? '' : inputs,
		result: chunked ? '' : result,
		...(chunked ? { chunked: true as const } : {})
	};
	const chunks: {
		section: 'payload';
		generation: number;
		order: number;
		fingerprint: string;
		recordCount: number;
		data: string;
	}[] = [];
	if (chunked) {
		const data = JSON.stringify([inputs, result]);
		if (data.length > 63 * 48 * 1024) throw new Error(envelopeError);
		for (let offset = 0; offset < data.length;) {
			let end = Math.min(offset + 48 * 1024, data.length);
			const before = data.charCodeAt(end - 1),
				after = data.charCodeAt(end);
			if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end++;
			const part = data.slice(offset, end);
			chunks.push({
				section: 'payload',
				generation: 0,
				order: chunks.length,
				fingerprint: receiptChunkFingerprint(part),
				recordCount: 0,
				data: part
			});
			offset = end;
		}
	}
	return { payload, chunks };
}

export function planReceiptWrite(
	companyId: Id<'company'>,
	key: string,
	inputs: string,
	result: string,
	ownership?: {
		contractId: Id<'savedContracts'>;
		actor?: Doc<'operationReceipts'>['actor'];
		documentId?: Id<'contractDocuments'>;
		kind?:
			| 'output-reservation'
			| 'quote-reservation'
			| 'quote-commit'
			| 'playbook-save'
			| 'change-decision'
			| 'proposal-support'
			| 'approval-request'
			| 'review-completion'
			| 'discussion-write'
			| 'discussion-mark-seen';
		requestedAt?: number;
		outputId?: Id<'contractOutputs'>;
	},
	pending?: Pick<
		Doc<'operationReceipts'>,
		'actor' | 'operationId' | 'preparation' | 'emailPreparation'
	>
) {
	const { payload, chunks } = encodeReceiptPayload(companyId, key, inputs, result);
	const { retryUntil, gcAfter, operationId } = receiptDeadline(key);
	if (pending?.operationId !== undefined && pending.operationId !== operationId)
		throw new Error('Pending operation identity does not match its key.');
	// A batch cannot adopt a command after that command's independent deadline.
	const executionUntil =
		ownership?.kind === 'playbook-save'
			? (JSON.parse(inputs) as [string, { commands: { id: string }[] }])[1].commands.reduce(
					(until, command) => Math.min(until, operation(command.id).retryUntil),
					retryUntil
				)
			: retryUntil;
	const row = {
		companyId,
		retryUntil,
		executionUntil,
		gcAfter,
		operationId,
		state: pending ? ('preparing' as const) : ('complete' as const),
		...ownership,
		...pending,
		key,
		...payload
	};
	const work = {
		documents: chunks.length + 1,
		bytes:
			documentBytes({ ...row, _id: 'x'.repeat(32), _creationTime: 0 }) +
			chunks.reduce(
				(sum, chunk) =>
					sum +
					documentBytes({
						...chunk,
						companyId,
						receiptId: 'x'.repeat(32),
						_id: 'x'.repeat(32),
						_creationTime: 0
					}),
				0
			)
	};
	return { row, chunks, work };
}
type ReceiptWriteArgs = Parameters<typeof planReceiptWrite>;
export async function remember(ctx: MutationCtx, ...args: ReceiptWriteArgs) {
	admitOperation(receiptDeadline(args[1]).operationId);
	const plan = planReceiptWrite(...args),
		id = await ctx.db.insert('operationReceipts', plan.row);
	for (const chunk of plan.chunks)
		await ctx.db.insert('operationReceiptChunks', {
			companyId: plan.row.companyId,
			receiptId: id,
			...chunk
		});
	return id;
}

/** Preparation owns this original receipt; completion cannot allocate a replacement replay identity. */
export async function sealReceipt(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	inputs: string,
	outcome:
		| { state: 'complete'; result: string }
		| { state: 'failed'; error: string; errorCode?: 'OPERATION_EXPIRED' }
) {
	const live = await ctx.db.get('operationReceipts', row._id);
	if (
		!live ||
		live.state !== 'preparing' ||
		live.key !== row.key ||
		live.companyId !== row.companyId
	)
		throw new Error('Only the original pending operation can be sealed.');
	if (outcome.state === 'complete') admitOperation(receiptDeadline(live.key).operationId);
	const payload = await receiptPayload(ctx, live);
	if (payload.inputs !== inputs) throw new Error('Pending operation input changed.');
	const result = outcome.state === 'complete' ? outcome.result : '';
	const encoded = encodeReceiptPayload(live.companyId, live.key, inputs, result);
	if (live.chunked) {
		const chunks = await ctx.db
			.query('operationReceiptChunks')
			.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
				q.eq('receiptId', live._id).eq('section', 'payload').eq('generation', 0)
			)
			.take(64);
		if (chunks.length >= 64) throw new Error('Receipt exceeds its storage envelope.');
		for (const chunk of chunks) await ctx.db.delete('operationReceiptChunks', chunk._id);
	}
	for (const chunk of encoded.chunks)
		await ctx.db.insert('operationReceiptChunks', {
			companyId: live.companyId,
			receiptId: live._id,
			...chunk
		});
	await ctx.db.patch('operationReceipts', live._id, {
		state: outcome.state,
		...encoded.payload,
		chunked: encoded.payload.chunked,
		preparation: undefined,
		emailPreparation: undefined,
		error: outcome.state === 'failed' ? outcome.error : undefined,
		errorCode: outcome.state === 'failed' ? outcome.errorCode : undefined
	});
	// Release the original map only after this receipt stops owning it. A committed
	// event or another exact active preparation can still retain the shared chunks.
	if (live.preparation?.map && live.contractId)
		await retireDiscussionMap(
			ctx,
			{ companyId: live.companyId, contractId: live.contractId },
			live.preparation.map
		);
	if (live.preparation?.native)
		await queueNativeCleanup(ctx, live._id, live.preparation.native.generation);
}

export function actorOf(profile: Pick<Doc<'profiles'>, 'name' | 'email'>) {
	return { name: profile.name, email: profile.email };
}
export function actionKey(access: CompanyAccess, kind: string, id: string) {
	operation(id);
	return operationKey(access.membershipId, kind, id);
}
export async function sha256(value: string) {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
		(b) => b.toString(16).padStart(2, '0')
	).join('');
}

/** Called only by company erasure; individual contract deletion preserves replay fences. */
export async function cleanupCompanyOperations(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	{ drain } = cleanupBudget(ctx)
) {
	// Remove each exact owner before its sections so no delayed preparation can append
	// new proof/native payload after the company section pass has completed.
	if (
		!(await drain(
			'operationReceipts',
			ctx.db
				.query('operationReceipts')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
			{
				beforeDelete: async (row) => {
					for (const jobId of [
						row.preparation?.native?.jobId,
						row.preparation?.passageJobId,
						row.nativeCleanup?.jobId
					])
						await cancelJob(ctx, jobId);
				}
			}
		))
	)
		return false;
	if (
		!(await drain(
			'operationReceiptChunks',
			ctx.db
				.query('operationReceiptChunks')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
		))
	)
		return false;

	return true;
}

export async function receiptSealWork(
	ctx: QueryCtx,
	row: Doc<'operationReceipts'>,
	inputs: string,
	result: string
) {
	const old = row.chunked
		? await ctx.db
				.query('operationReceiptChunks')
				.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
					q.eq('receiptId', row._id).eq('section', 'payload').eq('generation', 0)
				)
				.take(64)
		: [];
	if (old.length > 63) throw new Error('Original receipt exceeds its payload envelope.');
	const { payload, chunks } = encodeReceiptPayload(
		row.companyId,
		row.key,
		inputs,
		result,
		'Native result exceeds the existing ordinary replay envelope.'
	);
	let bytes = chunks.reduce(
		(sum, chunk) =>
			sum +
			documentBytes({
				companyId: row.companyId,
				receiptId: row._id,
				...chunk,
				_id: 'x'.repeat(32),
				_creationTime: 0
			}),
		0
	);
	let writes = old.length + 1 + chunks.length;
	const { preparation: _preparation, error: _error, ...fields } = row;
	const sealed = {
		...fields,
		state: 'complete',
		...payload,
		chunked: payload.chunked
	};
	const sealedBytes = documentBytes(sealed);
	bytes += sealedBytes;
	if (row.preparation?.native) {
		writes++;
		bytes += documentBytes({
			...sealed,
			nativeCleanup: {
				...(row.nativeCleanup ?? { version: 1, phase: 'documents', offset: 0 }),
				through: Math.max(row.nativeCleanup?.through ?? -1, row.preparation.native.generation),
				dueAt: 0,
				jobId: 'x'.repeat(32)
			}
		});
	}
	const oldBytes = old.reduce((n, chunk) => n + documentBytes(chunk), 0);
	const mapRelease = Boolean(row.preparation?.map && !row.preparation.map.inline);
	return {
		bytes: bytes + oldBytes + (mapRelease ? 4096 : 0),
		writes: writes + Number(mapRelease),
		readBytes:
			oldBytes * 2 +
			getDocumentSize(row) * 3 +
			sealedBytes +
			64 * 1024 +
			(mapRelease ? 256 * 1024 : 0),
		reads: old.length * 2 + 4 + (mapRelease ? 3 : 0)
	};
}
