import { ConvexError, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { CompanyAccess } from './auth';
import type { Contract } from './contractState';
import { DiscussionIndex } from './discussionIndex';
import {
	expectedSourceOf,
	requireExpectedSource,
	requireReadySource,
	sourceDocument,
	staleSource
} from './contractSource';
import { requireContractWork } from './contractPolicy';
import { canonicalJson } from '../lib/document/canonical-json';
import { receiptChunkFingerprint, receiptSectionHash } from './operationReceipts';
import {
	changeActorOf,
	readChangeRow,
	effectiveDecision,
	MAX_APPROVED_CHANGE_CHAIN
} from './contractChanges';
import { requireNativeReachability } from './nativeStage';
import type { outputDestination, outputProof } from './outputValidators';
import type { OutputPreparation, OutputProofCursor, ReservationManifest } from './outputValidators';

const encoder = new TextEncoder();
const FRAGMENT_UNITS = 8 * 1024;
type ProofChunk = Omit<Doc<'operationReceiptChunks'>, '_id' | '_creationTime'>;
type OrdinaryProofWalk = {
	chunks: ProofChunk[];
	heads?: AsyncIterator<Doc<'contractChangeHeads'>>;
	decisions?: AsyncIterator<Doc<'contractChangeDecisions'>>;
	decision?: Doc<'contractChangeDecisions'>;
	iterators: AsyncIterator<unknown>[];
};
type ProofSources = {
	change?: Doc<'contractChanges'>;
	part?: Doc<'contractChangeContents'>;
};
export const MAX_PROOF_CHUNK_BYTES = 96 * 1024;
export async function outputDestinationOf(
	ctx: QueryCtx,
	contract: Contract
): Promise<Infer<typeof outputDestination>> {
	const connection = await requireContractWork(ctx, contract);
	const hubspot = contract.hubspot
		? {
				connectionId: contract.hubspot.connectionId,
				accountId: contract.hubspot.accountId,
				dealId: contract.hubspot.dealId,
				generation: contract.hubspot.generation
			}
		: null;
	return { hubspot, connectionGeneration: connection?.generation ?? null };
}
export async function outputFenceOf(
	ctx: QueryCtx,
	contract: Contract,
	destination?: Infer<typeof outputDestination>
) {
	const index = await DiscussionIndex.open(ctx, contract.root);
	return {
		source: expectedSourceOf(contract),
		supportGeneration: index.supportIndexGeneration,
		storageGeneration: index.nativeStorageGeneration,
		destination: destination ?? (await outputDestinationOf(ctx, contract))
	};
}
export async function requireOutputFence(
	ctx: QueryCtx,
	contract: Contract,
	preparation: OutputPreparation
) {
	requireExpectedSource(contract, preparation.fence.source);
	await requireReadySource(ctx, contract);
	const current = await outputFenceOf(ctx, contract);
	// Quote-specific installation/epoch are checked by its concrete reservation/commit gate.
	const { installationId: _id, epoch: _epoch, ...destination } = preparation.fence.destination;
	if (canonicalJson({ ...preparation.fence, destination }) !== canonicalJson(current))
		throw staleSource();
}
export async function initialOutputPreparation(
	ctx: QueryCtx,
	contract: Contract,
	access: CompanyAccess,
	purpose: OutputPreparation['purpose'],
	generation: number,
	destination?: Infer<typeof outputDestination>
): Promise<OutputPreparation> {
	await requireReadySource(ctx, contract);
	const document = await sourceDocument(ctx, contract),
		fence = await outputFenceOf(ctx, contract, destination);
	const identity = receiptChunkFingerprint(
		canonicalJson({
			schema: 1,
			title: contract.root.title,
			templateVersionId: contract.root.templateVersionId,
			documentFingerprint: document.fingerprint
		})
	);
	return {
		purpose,
		generation,
		base: {
			companyId: contract.root.companyId,
			contractId: contract.root._id,
			documentId: document._id,
			documentFingerprint: document.fingerprint,
			templateVersionId: contract.root.templateVersionId,
			title: contract.root.title,
			actor: changeActorOf(access),
			membershipId: access.membershipId,
			requestedAt: Date.now(),
			expectedSource: fence.source,
			destination: fence.destination
		},
		fence,
		phase: 'heads',
		headCursor: null,
		headDone: false,
		depth: 0,
		contentOrder: 0,
		contentOffset: 0,
		decisionCursor: null,
		chunks: 0,
		records: 0,
		bytes: 0,
		hash: '',
		identity,
		dueAt: Date.now()
	};
}
export function proofSeed(row: Doc<'operationReceipts'>, preparation: OutputPreparation) {
	return receiptChunkFingerprint(
		canonicalJson({
			receiptId: row._id,
			key: row.key,
			operationId: row.operationId,
			actor: row.actor,
			base: preparation.base,
			fence: preparation.fence,
			schema: 1,
			section: 'output-proof',
			generation: preparation.generation
		})
	);
}
export function sealedManifest(
	row: Doc<'operationReceipts'>,
	preparation: OutputPreparation
): ReservationManifest {
	if (preparation.phase !== 'sealed') throw new Error('Output proof is not sealed.');
	return {
		...preparation.base,
		identity: preparation.identity,
		proof: {
			receiptId: row._id,
			companyId: row.companyId,
			contractId: preparation.base.contractId,
			schema: 1,
			section: 'output-proof',
			generation: preparation.generation,
			chunks: preparation.chunks,
			records: preparation.records,
			bytes: preparation.bytes,
			hash: preparation.hash,
			bindingHash: proofSeed(row, preparation)
		}
	};
}
async function append(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	preparation: OutputPreparation,
	record: unknown,
	walk?: OrdinaryProofWalk
) {
	const data = canonicalJson(record),
		bytes = encoder.encode(data).byteLength;
	if (bytes > MAX_PROOF_CHUNK_BYTES)
		throw new Error('Output evidence record exceeds its page envelope.');
	const fingerprint = receiptChunkFingerprint(data),
		order = preparation.chunks;
	const chunk: ProofChunk = {
		companyId: row.companyId,
		receiptId: row._id,
		section: 'output-proof',
		generation: preparation.generation,
		order,
		fingerprint,
		recordCount: 1,
		data
	};
	if (walk) walk.chunks.push(chunk);
	else await ctx.db.insert('operationReceiptChunks', chunk);
	preparation.hash = receiptSectionHash(preparation.hash, order, fingerprint, 1);
	preparation.chunks++;
	preparation.records++;
	preparation.bytes += bytes;
}
/** Every serialized immutable row is frozen in bounded ordered fragments. No patch is hydrated. */
async function fragment(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	preparation: OutputPreparation,
	kind: string,
	id: string,
	serialized: string,
	order = 0,
	walk?: OrdinaryProofWalk
) {
	const offset = preparation.contentOffset;
	if (offset < 0 || offset > serialized.length) throw new Error('Invalid output evidence cursor.');
	let end = Math.min(offset + FRAGMENT_UNITS, serialized.length);
	if (
		end < serialized.length &&
		serialized.charCodeAt(end - 1) >= 0xd800 &&
		serialized.charCodeAt(end - 1) <= 0xdbff &&
		serialized.charCodeAt(end) >= 0xdc00 &&
		serialized.charCodeAt(end) <= 0xdfff
	)
		end++;
	await append(
		ctx,
		row,
		preparation,
		{
			kind,
			id,
			order,
			offset,
			final: end === serialized.length,
			data: serialized.slice(offset, end)
		},
		walk
	);
	preparation.contentOffset = end === serialized.length ? 0 : end;
	return end === serialized.length;
}
function immutableChange(row: Doc<'contractChanges'>) {
	const { _creationTime: _time, stage: _stage, ...value } = row;
	return value;
}
function immutableDecision(row: Doc<'contractChangeDecisions'>) {
	const { _creationTime: _time, stage: _stage, ...value } = row;
	return value;
}
async function committedDecision(ctx: QueryCtx, decision: Doc<'contractChangeDecisions'>) {
	if (!decision.stage) return true;
	const owner = await ctx.db.get('operationReceipts', decision.stage.receiptId);
	return !!(
		decision.stage.sealed &&
		owner?.state === 'complete' &&
		owner.companyId === decision.companyId &&
		owner.contractId === decision.contractId &&
		owner.nativeResult?.generation === decision.stage.generation &&
		owner.nativeResult.decisionIds.includes(decision._id)
	);
}
async function currentProofChange(
	ctx: QueryCtx,
	contract: Contract,
	id: Id<'contractChanges'>,
	sources: ProofSources
) {
	if (sources.change?._id !== id) {
		sources.change = await readChangeRow(ctx, id, contract);
		sources.part = undefined;
	}
	return sources.change;
}
/** One native-key/ancestor/content/decision unit. State is a constant-size durable cursor. */
async function unit(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	contract: Contract,
	preparation: OutputPreparation,
	sources: ProofSources,
	walk?: OrdinaryProofWalk
) {
	if (preparation.phase === 'heads') {
		sources.change = undefined;
		sources.part = undefined;
		if (preparation.headDone) {
			preparation.phase = 'sealed';
			return;
		}
		const query = ctx.db
			.query('contractChangeHeads')
			.withIndex('by_contractId_and_kind_and_key', (q) => q.eq('contractId', row.contractId!));
		let head: Doc<'contractChangeHeads'> | undefined;
		if (walk) {
			if (!walk.heads) {
				walk.heads = query[Symbol.asyncIterator]();
				walk.iterators.push(walk.heads);
			}
			const next = await walk.heads.next();
			preparation.headDone = Boolean(next.done);
			head = next.done ? undefined : next.value;
		} else {
			const page = await query.paginate({
				cursor: preparation.headCursor,
				numItems: 1,
				maximumRowsRead: 1,
				maximumBytesRead: 64 * 1024
			});
			preparation.headCursor = page.continueCursor;
			preparation.headDone = page.isDone;
			head = page.page[0];
		}
		if (!head) return;
		if (head.companyId !== row.companyId || head.contractId !== row.contractId)
			throw new Error('Output head ownership changed.');
		// Applied evidence deliberately has no live discussion/source predicate. Pending buyer
		// supports are certified by exact readiness summaries, including effective cancellation.
		if (!head.appliedChangeId) return;
		const change = await currentProofChange(ctx, contract, head.appliedChangeId, sources);
		if (change.kind !== head.kind || change.key !== head.key)
			throw new Error('Invalid applied output head.');
		const decision = head.appliedDecisionId
			? await effectiveDecision(ctx, contract, change._id, head.appliedDecisionId)
			: null;
		if (
			(change.policy === 'required' && decision?.status !== 'approved') ||
			(change.policy === 'none' && decision)
		)
			throw new Error('Applied output has no exact authorization.');
		const value = {
			kind: head.kind,
			key: head.key,
			changeId: change._id,
			decisionId: decision?._id ?? null
		};
		preparation.identity = receiptChunkFingerprint(canonicalJson([preparation.identity, value]));
		await append(
			ctx,
			row,
			preparation,
			{
				type: 'head',
				...value
			},
			walk
		);
		preparation.changeId = change._id;
		preparation.depth = 0;
		preparation.phase = 'change';
	} else if (preparation.phase === 'change') {
		const change = await currentProofChange(ctx, contract, preparation.changeId!, sources);
		if (
			await fragment(
				ctx,
				row,
				preparation,
				'change',
				change._id,
				canonicalJson(immutableChange(change)),
				0,
				walk
			)
		) {
			preparation.phase = 'contents';
			preparation.contentOrder = 0;
		}
	} else if (preparation.phase === 'contents') {
		const change = await currentProofChange(ctx, contract, preparation.changeId!, sources);
		if (!Number.isSafeInteger(change.chunks) || change.chunks < 1 || change.chunks > 64)
			throw new Error('Invalid immutable output patch envelope.');
		if (preparation.contentOrder >= change.chunks) {
			sources.part = undefined;
			preparation.phase = 'decisions';
			preparation.decisionCursor = null;
			if (walk) {
				walk.decisions = undefined;
				walk.decision = undefined;
			}
			return;
		}
		if (
			sources.part?.changeId !== change._id ||
			sources.part.order !== preparation.contentOrder
		) {
			const chunk = await ctx.db
				.query('contractChangeContents')
				.withIndex('by_changeId_and_order', (q) =>
					q.eq('changeId', change._id).eq('order', preparation.contentOrder)
				)
				.unique();
			if (!chunk || chunk.companyId !== row.companyId || chunk.contractId !== row.contractId)
				throw new Error('Output dependency patch is incomplete.');
			sources.part = chunk;
		}
		const chunk = sources.part;
		if (await fragment(ctx, row, preparation, 'patch', change._id, chunk.data, chunk.order, walk)) {
			preparation.contentOrder++;
			sources.part = undefined;
		}
	} else if (preparation.phase === 'decisions') {
		const change = await currentProofChange(ctx, contract, preparation.changeId!, sources);
		const query = ctx.db
			.query('contractChangeDecisions')
			.withIndex('by_changeId_and_decidedAt', (q) => q.eq('changeId', change._id));
		let page: {
			page: Doc<'contractChangeDecisions'>[];
			isDone: boolean;
			continueCursor: string | null;
		};
		if (walk) {
			if (!walk.decisions) {
				walk.decisions = query[Symbol.asyncIterator]();
				walk.iterators.push(walk.decisions);
			}
			const next = walk.decision
				? { done: false, value: walk.decision }
				: await walk.decisions.next();
			walk.decision = next.done ? undefined : next.value;
			page = {
				page: next.done ? [] : [next.value],
				isDone: Boolean(next.done),
				continueCursor: null
			};
		} else
			page = await query.paginate({
				cursor: preparation.decisionCursor,
				numItems: 1,
				maximumRowsRead: 1,
				maximumBytesRead: 64 * 1024
			});
		for (const decision of page.page) {
			if (decision.companyId !== row.companyId || decision.contractId !== row.contractId)
				throw new Error('Output dependency decision ownership is invalid.');
			if (await committedDecision(ctx, decision)) {
				await requireNativeReachability(ctx, 'contractChangeDecisions', decision._id, decision);
				if (
					!(await fragment(
						ctx,
						row,
						preparation,
						'decision',
						decision._id,
						canonicalJson(immutableDecision(decision)),
						0,
						walk
					))
				)
					return;
			}
		}
		if (walk) walk.decision = undefined;
		preparation.decisionCursor = page.continueCursor;
		if (page.isDone) {
			sources.change = undefined;
			sources.part = undefined;
			if (change.predecessorId) {
				preparation.depth++;
				if (preparation.depth >= MAX_APPROVED_CHANGE_CHAIN)
					throw new Error('Invalid cyclic output dependency chain.');
				preparation.changeId = change.predecessorId;
				preparation.phase = 'change';
			} else {
				preparation.changeId = undefined;
				preparation.phase = 'heads';
			}
		}
	}
}
/** Small reservations finish here; larger proofs checkpoint actual progress on their owner. */
export async function advanceOutputProof(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	contract: Contract,
	ordinary = false
) {
	let preparation = structuredClone(row.outputPreparation!);
	// Only the current validated change and immutable part live for this invocation.
	const sources: ProofSources = {};
	const walk: OrdinaryProofWalk | undefined =
		ordinary && !preparation.hash ? { chunks: [], iterators: [] } : undefined;
	await requireOutputFence(ctx, contract, preparation);
	if (!preparation.hash) preparation.hash = proofSeed(row, preparation);
	try {
		for (let count = 0; count < 48 && preparation.phase !== 'sealed'; count++) {
			const metrics = await ctx.meta.getTransactionMetrics();
			if (
				metrics.bytesRead.remaining < 2_500_000 ||
				metrics.bytesWritten.remaining < 1_000_000 + (walk ? preparation.bytes : 0) ||
				metrics.databaseQueries.remaining < 48 ||
				metrics.documentsRead.remaining < 48 ||
				metrics.documentsWritten.remaining < 32 + (walk?.chunks.length ?? 0)
			)
				break;
			await unit(ctx, row, contract, preparation, sources, walk);
		}
	} finally {
		if (walk) for (const iterator of walk.iterators) await iterator.return?.();
	}
	if (walk) {
		if (preparation.phase === 'sealed')
			for (const chunk of walk.chunks) await ctx.db.insert('operationReceiptChunks', chunk);
		else {
			// The ordinary attempt has made no writes. Only actual work/metric overflow
			// falls back to the existing durable native-page traversal on this receipt.
			preparation = structuredClone(row.outputPreparation!);
			preparation.hash = proofSeed(row, preparation);
		}
	}
	preparation.dueAt = preparation.phase === 'sealed' ? undefined : Date.now();
	await ctx.db.patch('operationReceipts', row._id, { outputPreparation: preparation });
	return preparation;
}
export function initialProofCursor(proof: Infer<typeof outputProof>): OutputProofCursor {
	return { order: 0, records: 0, bytes: 0, hash: proof.bindingHash };
}
/** Bounded reusable integrity fold; callers persist this cursor, never concatenate pages. */
export async function foldOutputProofPage(
	ctx: QueryCtx,
	manifest: ReservationManifest,
	cursor: OutputProofCursor
) {
	const proof = manifest.proof,
		next = { ...cursor };
	if (next.order > proof.chunks) throw new Error('Output proof cursor exceeds its seal.');
	const chunks = await ctx.db
		.query('operationReceiptChunks')
		.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
			q
				.eq('receiptId', proof.receiptId)
				.eq('section', proof.section)
				.eq('generation', proof.generation)
				.gte('order', next.order)
		)
		.take(4);
	for (const chunk of chunks) {
		const bytes = encoder.encode(chunk.data).byteLength;
		if (
			chunk.companyId !== proof.companyId ||
			chunk.order !== next.order ||
			chunk.order >= proof.chunks ||
			chunk.recordCount !== 1 ||
			bytes > MAX_PROOF_CHUNK_BYTES ||
			receiptChunkFingerprint(chunk.data) !== chunk.fingerprint
		)
			throw new Error('Output proof has invalid ownership, order or integrity.');
		next.hash = receiptSectionHash(next.hash, chunk.order, chunk.fingerprint, chunk.recordCount);
		next.order++;
		next.records += chunk.recordCount;
		next.bytes += bytes;
	}
	const complete = next.order === proof.chunks;
	if (
		(!chunks.length && !complete) ||
		(complete &&
			(next.records !== proof.records || next.bytes !== proof.bytes || next.hash !== proof.hash))
	)
		throw new Error('Output proof does not match its immutable seal.');
	return { cursor: next, complete };
}
/** Replay reads only the bounded manifest and its owner seal. No proof flattening. */
export async function outputReservation(
	ctx: QueryCtx,
	source: {
		companyId: Id<'company'>;
		contractId: Id<'savedContracts'>;
		reservationReceiptId: Id<'operationReceipts'>;
		documentId: Id<'contractDocuments'>;
	}
) {
	const owner = await ctx.db.get('operationReceipts', source.reservationReceiptId),
		manifest = owner?.reservationManifest;
	if (
		!owner ||
		owner.state !== 'complete' ||
		!manifest ||
		owner.companyId !== source.companyId ||
		owner.contractId !== source.contractId ||
		owner.documentId !== source.documentId ||
		manifest.companyId !== source.companyId ||
		manifest.contractId !== source.contractId ||
		manifest.documentId !== source.documentId ||
		manifest.proof.receiptId !== owner._id ||
		manifest.proof.companyId !== owner.companyId ||
		manifest.proof.contractId !== owner.contractId ||
		manifest.proof.section !== 'output-proof' ||
		manifest.proof.schema !== 1
	)
		throw new ConvexError('This output reservation is unavailable. Prepare a new output.');
	return { owner, reservationManifest: manifest };
}
