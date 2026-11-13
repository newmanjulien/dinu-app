import { ConvexError, getConvexSize, v, type Infer } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import {
	internalQuery,
	internalMutation,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import schema from './schema';
import { authorizePreparedOperation } from './discussionPreparation';
import { DiscussionIndex } from './discussionIndex';
import { admitDiscussionWork, DiscussionPreparationRequired } from './discussionMaps';
import {
	changeHead,
	hydrateHead,
	MAX_APPROVED_CHANGE_CHAIN,
	readChangeRow
} from './contractChanges';
import { contractReader } from './contractReader';
import {
	actionKey,
	operation,
	receipt,
	receiptChunkFingerprint,
	receiptPayload,
	receiptSectionHash,
	sealReceipt
} from './operationReceipts';
import { MAX_SAVE_COMMANDS, type PlaybookCommand } from '../lib/contract/changes';
import { MAX_SELECTED_CONCESSIONS } from '../lib/document/selection-limits';
import { canonicalJson } from '../lib/document/canonical-json';
import { nativeValidation } from './discussionPreparationValidators';
import { activeJob } from './emailDeliveries';
import type { Contract } from './contractState';
import { ensureDiscussionMaintenance } from './discussionMaintenance';
import { advanceConstruction } from './nativeConstruction';

type Validation = Infer<typeof nativeValidation>;
type Owner = { receiptId: Id<'operationReceipts'>; generation: number; unit: number };
const ownerArgs = {
	receiptId: v.id('operationReceipts'),
	generation: v.number(),
	unit: v.number()
};
export const nativeSourceAction = makeFunctionReference<'action', Owner, null>(
	'nativePlanPreparationAction:validateSource'
);
const hash = (value: unknown) => receiptChunkFingerprint(canonicalJson(value));

/** The bounded manifest binds exact mutable native tuples; payloads remain immutable IDs. */
type HeadRecord = {
	key: string;
	head: Doc<'contractChangeHeads'> | null;
	current: Id<'contractChanges'> | null;
	applied: Id<'contractChanges'> | null;
	currentDecision: Id<'contractChangeDecisions'> | null;
	appliedDecision: Id<'contractChangeDecisions'> | null;
	roots: Id<'contractChanges'>[];
	tupleHash: string;
};

export async function nativeValidationCurrent(
	ctx: QueryCtx,
	row: Doc<'operationReceipts'>,
	contract: Contract
) {
	const prepared = row.preparation;
	if (
		!prepared?.native ||
		!['playbook-save', 'change-decision', 'proposal-support'].includes(row.kind ?? '')
	)
		return false;
	const index = await DiscussionIndex.open(ctx, contract.root);
	return (
		prepared.sourceDocumentId === contract.root.documentId &&
		prepared.sourceDocumentRevision === contract.root.documentRevision &&
		prepared.nativeStateRevision === contract.root.stateRevision &&
		(prepared.native.phase === 'sealed' ||
			(prepared.storageGeneration === index.nativeStorageGeneration &&
				prepared.supportGeneration === index.supportIndexGeneration))
	);
}

async function owned(ctx: QueryCtx, args: Owner) {
	const row = await ctx.db.get('operationReceipts', args.receiptId);
	const native = row?.preparation?.native;
	if (
		!row ||
		row.state !== 'preparing' ||
		!native ||
		native.generation !== args.generation ||
		native.unit !== args.unit
	)
		return null;
	const authorized = await authorizePreparedOperation(ctx, row);
	if (!(await nativeValidationCurrent(ctx, row, authorized.contract))) return null;
	return { row, native, ...authorized };
}

async function append(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	native: Validation,
	section: 'native-plan' | 'native-sources',
	value: unknown
) {
	const data = canonicalJson(value);
	if (getConvexSize(data) > 128 * 1024)
		throw new Error('Native validation record exceeds its bounded envelope.');
	const fingerprint = receiptChunkFingerprint(data);
	const order = section === 'native-plan' ? native.records : native.sourceRecords;
	await ctx.db.insert('operationReceiptChunks', {
		companyId: row.companyId,
		receiptId: row._id,
		section,
		generation: native.generation,
		order,
		fingerprint,
		recordCount: 1,
		data
	});
	const bytes = new TextEncoder().encode(data).length;
	if (section === 'native-plan') {
		native.recordsHash = receiptSectionHash(native.recordsHash, order, fingerprint, 1);
		native.records++;
		native.recordsBytes += bytes;
	} else {
		native.sourceHash = receiptSectionHash(native.sourceHash, order, fingerprint, 1);
		native.sourceRecords++;
		native.sourceBytes += bytes;
	}
}

function headRecord(key: string, item: Awaited<ReturnType<typeof hydrateHead>> | null): HeadRecord {
	const roots = [
		...new Set(
			[item?.current?._id, item?.applied?._id].filter((id): id is Id<'contractChanges'> =>
				Boolean(id)
			)
		)
	];
	const tuple = {
		key,
		head: item?.storedHead ?? null,
		current: item?.current?._id ?? null,
		applied: item?.applied?._id ?? null,
		currentDecision: item?.decision?._id ?? null,
		appliedDecision: item?.appliedDecision?._id ?? null,
		roots
	};
	return {
		...tuple,
		tupleHash: hash([
			tuple,
			item?.current ?? null,
			item?.applied ?? null,
			item?.decision ?? null,
			item?.appliedDecision ?? null
		])
	};
}

function saveInput(inputs: string, contractId: Id<'savedContracts'>, operationId: string) {
	const parsed: unknown = JSON.parse(inputs);
	if (
		!Array.isArray(parsed) ||
		parsed.length !== 2 ||
		parsed[0] !== contractId ||
		!parsed[1] ||
		typeof parsed[1] !== 'object'
	)
		throw new Error('Pending save input is invalid.');
	const value = parsed[1] as { commands?: PlaybookCommand[]; operationId?: string };
	if (
		value.operationId !== operationId ||
		!Array.isArray(value.commands) ||
		value.commands.length > MAX_SAVE_COMMANDS
	)
		throw new Error('Pending save command identity is invalid.');
	const ids = new Set<string>(),
		expected = new Map<string, string | null>();
	for (const command of value.commands) {
		operation(command.id);
		if (
			ids.has(command.id) ||
			!Number.isFinite(command.occurredAt) ||
			(expected.has(command.itemId) &&
				expected.get(command.itemId) !== command.expectedCurrentChangeId)
		)
			throw new ConvexError('Invalid contract change.');
		ids.add(command.id);
		expected.set(command.itemId, command.expectedCurrentChangeId);
	}
	return value.commands;
}

/** Each examined target/head commits its exact cursor and manifest append together.
 * This is input validation, never an adoption seal or permission to publish a staged row. */
export async function advanceNativeValidation(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	contract: Contract
): Promise<'progress' | 'sealed' | 'stale' | 'conflict'> {
	if (!(await nativeValidationCurrent(ctx, row, contract))) return 'stale';
	const original = row.preparation!;
	const native = structuredClone(original.native!);
	if (native.phase === 'validated' || native.phase === 'constructing' || native.phase === 'sealed')
		return advanceConstruction(ctx, row, contract);
	if (native.phase === 'sources') {
		if (!(await activeJob(ctx, native.jobId))) {
			native.jobId = await ctx.scheduler.runAfter(0, nativeSourceAction, {
				receiptId: row._id,
				generation: native.generation,
				unit: native.unit
			});
			await ctx.db.patch('operationReceipts', row._id, {
				preparation: { ...original, native, dueAt: Date.now() }
			});
		}
		return 'progress';
	}
	const { access } = await authorizePreparedOperation(ctx, row);
	if (!access) throw new Error('Native Playbook validation lost its seller.');
	const commands = saveInput(
		(await receiptPayload(ctx, row)).inputs,
		contract.root._id,
		row.operationId!
	);
	const reader = await contractReader(ctx, contract.root);
	let progressed = false;
	try {
		for (let turn = 0; turn < 8; turn++) {
			await admitDiscussionWork(ctx, { reads: 16, queries: 16, writes: 2, bytes: 160 * 1024 });
			if (native.phase === 'targets') {
				const command = commands[native.commandCursor];
				if (!command) {
					native.phase = 'playbook';
					progressed = true;
					continue;
				}
				const head = await changeHead(ctx, contract, 'playbook', command.itemId);
				if ((head?.current?._id ?? null) !== command.expectedCurrentChangeId) return 'conflict';
				const commandKey = actionKey(access, 'application', command.id);
				if (await receipt(ctx, commandKey, JSON.stringify([contract.root._id, command])))
					throw new ConvexError(
						'This contract change was already accepted. Reload before applying it again.'
					);
				const item = await reader.item(command.itemId);
				const optionId = command.action.kind === 'set' ? command.action.optionId : null;
				if (
					!item ||
					(command.action.kind === 'set' &&
						command.action.optionId !== null &&
						!item.choices.some((choice) => choice.id === optionId))
				)
					throw new ConvexError('This Playbook option is unavailable.');
				await append(ctx, row, native, 'native-plan', {
					kind: 'target',
					commandIndex: native.commandCursor,
					commandKey,
					policy: item.review.kind,
					contentRevision: item.contentRevision,
					...headRecord(command.itemId, head)
				});
				native.commandCursor++;
				progressed = true;
				continue;
			}
			if (native.phase !== 'playbook') break;
			const page = await ctx.db
				.query('contractChangeHeads')
				.withIndex('by_contractId_and_kind_and_activePlaybook', (q) =>
					q.eq('contractId', contract.root._id).eq('kind', 'playbook').eq('activePlaybook', true)
				)
				.paginate({
					cursor: native.playbookCursor,
					numItems: 1,
					maximumRowsRead: 1,
					maximumBytesRead: 32 * 1024
				});
			for (const head of page.page) {
				await append(ctx, row, native, 'native-plan', {
					kind: 'playbook',
					...headRecord(head.key, await hydrateHead(ctx, contract, head))
				});
				native.activePlaybookCount++;
				if (native.activePlaybookCount > MAX_SELECTED_CONCESSIONS)
					throw new Error('Playbook selection bound failed.');
			}
			native.playbookCursor = page.continueCursor;
			if (page.isDone) native.phase = 'sources';
			progressed = true;
		}
	} catch (error) {
		if (!(error instanceof DiscussionPreparationRequired)) throw error;
	}
	if (progressed) native.unit++;
	await ctx.db.patch('operationReceipts', row._id, {
		preparation: { ...original, native, dueAt: Date.now() }
	});
	return 'progress';
}

async function planRecord(
	ctx: QueryCtx,
	row: Doc<'operationReceipts'>,
	native: Validation
): Promise<HeadRecord | null> {
	if (native.sourceRecord >= native.records) return null;
	const chunk = await ctx.db
		.query('operationReceiptChunks')
		.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
			q
				.eq('receiptId', row._id)
				.eq('section', 'native-plan')
				.eq('generation', native.generation)
				.eq('order', native.sourceRecord)
		)
		.unique();
	if (
		!chunk ||
		chunk.companyId !== row.companyId ||
		receiptChunkFingerprint(chunk.data) !== chunk.fingerprint ||
		chunk.recordCount !== 1
	)
		throw new Error('Native validation manifest is incomplete.');
	const record: unknown = JSON.parse(chunk.data);
	if (
		!record ||
		typeof record !== 'object' ||
		!('roots' in record) ||
		!Array.isArray(record.roots) ||
		record.roots.length > 2 ||
		!('key' in record) ||
		typeof record.key !== 'string'
	)
		throw new Error('Native validation record is invalid.');
	for (const id of record.roots)
		if (typeof id !== 'string' || !ctx.db.normalizeId('contractChanges', id))
			throw new Error('Invalid native source ID.');
	return record as HeadRecord;
}

const sourceSnapshot = v.union(
	v.null(),
	v.object({ kind: v.literal('document'), manifest: schema.doc('contractDocuments') }),
	v.object({ kind: v.literal('change'), row: schema.doc('contractChanges') }),
	v.object({ kind: v.literal('next-record') }),
	v.object({ kind: v.literal('complete') })
);
export type NativeSourceSnapshot = Infer<typeof sourceSnapshot>;
export const source = internalQuery({
	args: ownerArgs,
	returns: sourceSnapshot,
	handler: async (ctx, args): Promise<NativeSourceSnapshot> => {
		const state = await owned(ctx, args);
		if (!state || state.native.phase !== 'sources') return null;
		const { row, native, contract } = state;
		if (!native.sourceDocumentValidated) {
			const manifest = await ctx.db.get('contractDocuments', row.preparation!.sourceDocumentId);
			if (
				!manifest ||
				manifest.companyId !== row.companyId ||
				manifest.contractId !== contract.root._id
			)
				throw new Error('Native source document is unavailable.');
			return { kind: 'document', manifest };
		}
		const record = await planRecord(ctx, row, native);
		if (!record) return { kind: 'complete' };
		const id = native.ancestorId ?? record.roots[native.sourceRoot];
		if (!id) return { kind: 'next-record' };
		if (native.ancestorIds.includes(id) || native.ancestorIds.length >= MAX_APPROVED_CHANGE_CHAIN)
			throw new ConvexError('This widget has too many wording revisions.');
		const change = await readChangeRow(ctx, id, contract);
		if (change.kind !== 'playbook' || change.key !== record.key)
			throw new Error('Invalid native predecessor identity.');
		return { kind: 'change', row: change };
	}
});

export const documentPage = internalQuery({
	args: { ...ownerArgs, offset: v.number() },
	returns: v.union(v.null(), v.array(schema.doc('contractDocumentChunks'))),
	handler: async (ctx, args) => {
		const state = await owned(ctx, args);
		if (!state || state.native.phase !== 'sources' || state.native.sourceDocumentValidated)
			return null;
		if (!Number.isSafeInteger(args.offset) || args.offset < 0)
			throw new Error('Invalid native document page.');
		const manifest = await ctx.db.get('contractDocuments', state.row.preparation!.sourceDocumentId);
		if (
			!manifest ||
			manifest.companyId !== state.row.companyId ||
			manifest.contractId !== state.contract.root._id ||
			manifest.chunkIds.length > 512
		)
			throw new Error('Native document manifest is invalid.');
		const result: Doc<'contractDocumentChunks'>[] = [];
		for (const id of manifest.chunkIds.slice(args.offset, args.offset + 4)) {
			const chunk = await ctx.db.get('contractDocumentChunks', id);
			if (
				!chunk ||
				chunk.companyId !== manifest.companyId ||
				chunk.contractId !== manifest.contractId
			)
				throw new Error('Native document chunk ownership is invalid.');
			result.push(chunk);
		}
		return result;
	}
});

export const changePage = internalQuery({
	args: { ...ownerArgs, changeId: v.id('contractChanges'), offset: v.number() },
	returns: v.union(v.null(), v.array(schema.doc('contractChangeContents'))),
	handler: async (ctx, args) => {
		const state = await owned(ctx, args);
		if (!state || state.native.phase !== 'sources') return null;
		const record = await planRecord(ctx, state.row, state.native);
		if (
			!record ||
			(state.native.ancestorId ?? record.roots[state.native.sourceRoot]) !== args.changeId
		)
			return null;
		if (!Number.isSafeInteger(args.offset) || args.offset < 0)
			throw new Error('Invalid native change page.');
		const row = await readChangeRow(ctx, args.changeId, state.contract);
		if (!Number.isSafeInteger(row.chunks) || row.chunks < 1 || row.chunks > 64)
			throw new Error('Invalid native change manifest.');
		const result: Doc<'contractChangeContents'>[] = [];
		for (let order = args.offset; order < Math.min(row.chunks, args.offset + 4); order++) {
			const chunk = await ctx.db
				.query('contractChangeContents')
				.withIndex('by_changeId_and_order', (q) => q.eq('changeId', row._id).eq('order', order))
				.unique();
			if (!chunk || chunk.companyId !== row.companyId || chunk.contractId !== row.contractId)
				throw new Error('Native change chunk ownership is invalid.');
			result.push(chunk);
		}
		return result;
	}
});

const sourceProof = v.union(
	v.object({
		kind: v.literal('document'),
		documentId: v.id('contractDocuments'),
		fingerprint: v.string(),
		chunks: v.number(),
		bytes: v.number()
	}),
	v.object({
		kind: v.literal('change'),
		changeId: v.id('contractChanges'),
		rowHash: v.string(),
		fingerprint: v.string(),
		chunks: v.number(),
		bytes: v.number()
	}),
	v.object({ kind: v.literal('next-record') }),
	v.object({ kind: v.literal('complete') })
);
export type NativeSourceProof = Infer<typeof sourceProof>;
export const checkpointSource = internalMutation({
	args: { ...ownerArgs, proof: sourceProof },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await owned(ctx, args);
		if (!state || state.native.phase !== 'sources') return null;
		const { row, contract } = state,
			native = structuredClone(state.native),
			proof = args.proof;
		await admitDiscussionWork(ctx, { reads: 4, queries: 4, writes: 2, bytes: 160 * 1024 });
		if (proof.kind === 'document') {
			if (native.sourceDocumentValidated || proof.documentId !== row.preparation!.sourceDocumentId)
				throw new Error('Native source document checkpoint changed.');
			const document = await ctx.db.get('contractDocuments', proof.documentId);
			if (
				!document ||
				document.companyId !== row.companyId ||
				document.contractId !== contract.root._id ||
				document.fingerprint !== proof.fingerprint ||
				document.chunkIds.length !== proof.chunks ||
				document.dataBytes !== proof.bytes
			)
				throw new Error('Native source document seal changed.');
			await append(ctx, row, native, 'native-sources', proof);
			native.sourceDocumentValidated = true;
		} else {
			if (!native.sourceDocumentValidated)
				throw new Error('Native source document has not been validated.');
			const record = await planRecord(ctx, row, native);
			if (proof.kind === 'complete') {
				if (record) throw new Error('Native source validation is incomplete.');
				native.phase = 'validated';
			} else if (proof.kind === 'next-record') {
				if (!record || native.ancestorId || native.sourceRoot < record.roots.length)
					throw new Error('Native predecessor validation is incomplete.');
				native.sourceRecord++;
				native.sourceRoot = 0;
				native.ancestorIds = [];
			} else {
				if (!record || (native.ancestorId ?? record.roots[native.sourceRoot]) !== proof.changeId)
					throw new Error('Native source cursor changed.');
				const change = await readChangeRow(ctx, proof.changeId, contract);
				if (
					hash(change) !== proof.rowHash ||
					change.chunks !== proof.chunks ||
					change.dataBytes !== proof.bytes
				)
					throw new Error('Native source change seal changed.');
				if (
					native.ancestorIds.includes(change._id) ||
					native.ancestorIds.length >= MAX_APPROVED_CHANGE_CHAIN
				)
					throw new Error('Invalid native predecessor chain.');
				await append(ctx, row, native, 'native-sources', {
					...proof,
					predecessorId: change.predecessorId ?? null,
					patchKey: change.patchKey
				});
				if (change.predecessorId) {
					native.ancestorId = change.predecessorId;
					native.ancestorIds.push(change._id);
				} else {
					native.ancestorId = undefined;
					native.ancestorIds = [];
					native.sourceRoot++;
				}
			}
		}
		native.unit++;
		native.jobId = undefined;
		await ctx.db.patch('operationReceipts', row._id, {
			preparation: { ...row.preparation!, native, dueAt: Date.now() }
		});
		await ensureDiscussionMaintenance(ctx, contract.root._id);
		return null;
	}
});

export const failSource = internalMutation({
	args: { ...ownerArgs, error: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('operationReceipts', args.receiptId);
		const native = row?.preparation?.native;
		if (
			!row ||
			row.state !== 'preparing' ||
			!native ||
			native.generation !== args.generation ||
			native.unit !== args.unit
		)
			return null;
		// The action only supplies a terminal diagnostic for this exact private unit.
		// Revocation must still be allowed to fail the old operation without granting access.
		await sealReceipt(ctx, row, (await receiptPayload(ctx, row)).inputs, {
			state: 'failed',
			error: args.error
		});
		if (row.contractId) await ensureDiscussionMaintenance(ctx, row.contractId);
		return null;
	}
});

/** Retention/failure cleanup may drain obsolete generations; an active source seal is protected. */
export async function drainNativeValidation(
	ctx: MutationCtx,
	receiptId: Id<'operationReceipts'>,
	generation: number
) {
	const owner = await ctx.db.get('operationReceipts', receiptId);
	if (!owner) throw new Error('Native preparation cleanup lost its receipt owner.');
	if (owner.state === 'preparing' && owner.preparation?.native?.generation === generation)
		throw new Error('Active native preparation remains reachable.');
	for (const section of ['native-plan', 'native-sources'] as const) {
		const rows = await ctx.db
			.query('operationReceiptChunks')
			.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
				q.eq('receiptId', receiptId).eq('section', section).eq('generation', generation)
			)
			.take(16);
		for (const row of rows) {
			await admitDiscussionWork(ctx, { writes: 1 });
			if (row.companyId !== owner.companyId)
				throw new Error('Native preparation cleanup ownership is invalid.');
			await ctx.db.delete('operationReceiptChunks', row._id);
		}
		if (rows.length) return false;
	}
	return true;
}
