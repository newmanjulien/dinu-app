import { expireOperation } from './operationExpiry';
import { prepareBuyerCurrentView } from './buyerCurrent';
import { ConvexError, getConvexSize, v, type Infer, type Value } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import schema from './schema';
import type { Contract } from './contractState';
import { patchContract } from './contractState';
import { nativeConstruction } from './discussionPreparationValidators';
import { authorizePreparedOperation } from './discussionPreparation';
import { authorityTarget, type AuthorityInput } from './contractAuthority';
import { nativeValidationCurrent } from './nativePlanPreparation';
import {
	receiptChunkFingerprint,
	receiptSectionHash,
	receiptPayload,
	sealReceipt,
	remember,
	actionKey,
	actorOf,
	receiptSealWork,
	planReceiptWrite
} from './operationReceipts';
import { canonicalJson } from '../lib/document/canonical-json';
import { contractReader } from './contractReader';
import type { PlaybookCommand, PlaybookState } from '../lib/contract/changes';
import { MAX_SAVE_COMMANDS } from '../lib/contract/changes';
import { MAX_SELECTED_CONCESSIONS } from '../lib/document/selection-limits';
import { MAX_PLAYBOOK_ITEMS } from '../lib/playbook/limits';
import { changeActorOf, MAX_APPROVED_CHANGE_CHAIN, playbookStateOf } from './contractChanges';
import { nativeAdoptionOwner, requireNativeReachability } from './nativeStage';
import { DiscussionIndex } from './discussionIndex';
import {
	admitDiscussionWork,
	DiscussionPreparationRequired,
	acquireDiscussionMap,
	discussionMapChunkHash,
	DISCUSSION_MAP_CHUNK_SPLICES,
	sealedDiscussionMap,
	stageDiscussionMapChunk
} from './discussionMaps';
import { discussionSplice, transitionManifest } from './discussionIndexValidators';
import { emptySupportCounts } from './discussionSupportTree';
import {
	ensureDiscussionMaintenance,
	scheduleDiscussionMaintenance
} from './discussionMaintenance';
import { requireContractWork } from './contractPolicy';
import { prepareActivity, boundActivityDetail } from './hubspotRecords';
import { contextIdentity, changedContextCompletion } from './contractReviewIdentity';
import { documentBytes } from './storageCapacity';
import type { ContractChange } from '../lib/playbook/model';
import {
	type HeadChangeSource,
	currentDecisionId,
	appliedDecisionId,
	assertChangeHead,
	createChangeHead,
	playbookProjection
} from './contractChangeHeads';

export type NativeOwner = { receiptId: Id<'operationReceipts'>; generation: number; unit: number };
export const nativeOwnerArgs = {
	receiptId: v.id('operationReceipts'),
	generation: v.number(),
	unit: v.number()
};
export type NativeBuild = Infer<typeof nativeConstruction>;
type BuiltChange = Extract<HeadChangeSource, { kind: 'playbook' }> & { _id: Id<'contractChanges'> };
type BuiltDecision = Pick<Doc<'contractChangeDecisions'>, '_id' | 'status'>;
export type BuiltHead = {
	key: string;
	stored: { _id: Id<'contractChangeHeads'>; activePlaybook: boolean } | null;
	initialCurrent: BuiltChange | null;
	initialDecision: BuiltDecision | null;
	current: BuiltChange | null;
	applied: BuiltChange | null;
	currentDecision: BuiltDecision | null;
	appliedDecision: BuiltDecision | null;
	dirty: boolean;
};
function compactChange(row: Doc<'contractChanges'> | null): BuiltChange | null {
	if (!row) return null;
	if (row.kind !== 'playbook') throw new Error('Native Playbook cache has a different kind.');
	return {
		_id: row._id,
		companyId: row.companyId,
		contractId: row.contractId,
		key: row.key,
		kind: row.kind,
		policy: row.policy,
		source: { itemId: row.source.itemId, optionId: row.source.optionId }
	};
}
type SealedCommand = {
	commandId: string;
	change: {
		id: Id<'contractChanges'>;
		unit: number;
		chunks: number;
		bytes: number;
		hash: string;
	} | null;
	decisionId: Id<'contractChangeDecisions'> | null;
	activityDetail: string | null;
};
async function sealCommand(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	b: NativeBuild,
	command: PlaybookCommand,
	change: Doc<'contractChanges'> | null,
	decisionId: Id<'contractChangeDecisions'> | null = null
) {
	const stage = change?.stage;
	if (
		change &&
		(!stage ||
			stage.receiptId !== row._id ||
			stage.generation !== row.preparation!.native!.generation ||
			!stage.sealed ||
			stage.written !== change.chunks ||
			stage.bytes !== change.dataBytes ||
			!stage.fingerprint)
	)
		throw new Error('Native command patch seal is incomplete.');
	const manifest: SealedCommand = {
		commandId: command.id,
		change: change
			? {
					id: change._id,
					unit: stage!.unit,
					chunks: change.chunks,
					bytes: change.dataBytes,
					hash: stage!.fingerprint!
				}
			: null,
		decisionId,
		activityDetail:
			change?.kind === 'playbook' && change.source.optionId !== null
				? boundActivityDetail(
						JSON.stringify({
							itemId: command.itemId,
							description: change.source.description,
							concessionId: change.source.optionId
						})
					)
				: null
	};
	const data = canonicalJson(manifest),
		fingerprint = receiptChunkFingerprint(data);
	await ctx.db.insert('operationReceiptChunks', {
		companyId: row.companyId,
		receiptId: row._id,
		section: 'native-result',
		generation: row.preparation!.native!.generation,
		nativeKey: `command:${b.command}`,
		order: -b.command - 1,
		recordCount: 1,
		data,
		fingerprint
	});
	b.commandHash = receiptSectionHash(b.commandHash, b.command, fingerprint, 1);
	b.commandBytes += new TextEncoder().encode(data).length;
	b.commandRecords++;
}
type SealedHead = {
	key: string;
	storedId: Id<'contractChangeHeads'> | null;
	dirty: boolean;
	row: ReturnType<typeof finalHead>;
};
function decodeSealedHead(row: Doc<'operationReceiptChunks'>): SealedHead {
	if (row.recordCount !== 1 || receiptChunkFingerprint(row.data) !== row.fingerprint)
		throw new Error('Native sealed head integrity failed.');
	const value = JSON.parse(row.data) as SealedHead;
	if (value.row) assertChangeHead(value.row);
	if (value.key !== row.nativeKey) throw new Error('Native sealed head identity failed.');
	return value;
}
export type ConstructionSnapshot = {
	build: NativeBuild;
	command: PlaybookCommand | null;
	target: BuiltHead | null;
	scan: BuiltHead | null;
	commandKey: string | null;
	approve: boolean;
	policy: 'none' | 'required';
	source: Extract<Doc<'contractChanges'>, { kind: 'playbook' }>['source'] | null;
	changes: ContractChange[];
	actor: ReturnType<typeof changeActorOf>;
	createdAt: number;
};
const hash = (value: unknown) => receiptChunkFingerprint(canonicalJson(value));
export const constructionAction = makeFunctionReference<'action', NativeOwner, null>(
	'nativeConstructionAction:construct'
);

export async function constructionOwned(ctx: QueryCtx, args: NativeOwner) {
	const row = await ctx.db.get('operationReceipts', args.receiptId),
		native = row?.preparation?.native;
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
	if (row.kind === 'change-decision' || row.kind === 'proposal-support') {
		if (!authorized.access) throw new Error('Authority operation lost its seller.');
		const input = JSON.parse((await receiptPayload(ctx, row)).inputs) as AuthorityInput;
		await authorityTarget(
			ctx,
			authorized.contract,
			authorized.access,
			input,
			await DiscussionIndex.open(ctx, authorized.contract.root)
		);
	}
	return { row, native, ...authorized };
}
function commandsOf(inputs: string) {
	const value = JSON.parse(inputs) as [string, { commands: PlaybookCommand[] }];
	if (!Array.isArray(value[1]?.commands) || value[1].commands.length > MAX_SAVE_COMMANDS)
		throw new Error('Invalid native command envelope.');
	return value[1].commands;
}
async function resultRow(ctx: QueryCtx, row: Doc<'operationReceipts'>, key: string) {
	return ctx.db
		.query('operationReceiptChunks')
		.withIndex('by_receiptId_and_section_and_generation_and_nativeKey', (q) =>
			q
				.eq('receiptId', row._id)
				.eq('section', 'native-result')
				.eq('generation', row.preparation!.native!.generation)
				.eq('nativeKey', key)
		)
		.unique();
}
function decodeHead(row: Doc<'operationReceiptChunks'>): BuiltHead {
	if (row.recordCount !== 1 || receiptChunkFingerprint(row.data) !== row.fingerprint)
		throw new Error('Native head checkpoint integrity failed.');
	const head = JSON.parse(row.data) as BuiltHead;
	if (head.key !== row.nativeKey) throw new Error('Native head checkpoint identity failed.');
	return head;
}
async function headAt(ctx: QueryCtx, row: Doc<'operationReceipts'>, order: number) {
	const chunk = await ctx.db
		.query('operationReceiptChunks')
		.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
			q
				.eq('receiptId', row._id)
				.eq('section', 'native-result')
				.eq('generation', row.preparation!.native!.generation)
				.eq('order', order)
		)
		.unique();
	if (!chunk || chunk.companyId !== row.companyId)
		throw new Error('Native head cursor is incomplete.');
	return decodeHead(chunk);
}
async function putHead(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	head: BuiltHead,
	order?: number
) {
	const data = canonicalJson(head);
	if (getConvexSize(data) > 128 * 1024)
		throw new Error('Native head exceeds its storage envelope.');
	const previous = await resultRow(ctx, row, head.key);
	const fields = { data, fingerprint: receiptChunkFingerprint(data) };
	if (previous) await ctx.db.patch('operationReceiptChunks', previous._id, fields);
	else {
		if (order === undefined) throw new Error('Native head has no assigned order.');
		await ctx.db.insert('operationReceiptChunks', {
			companyId: row.companyId,
			receiptId: row._id,
			section: 'native-result',
			generation: row.preparation!.native!.generation,
			nativeKey: head.key,
			order,
			recordCount: 1,
			...fields
		});
	}
}
export function initialNativeBuild(
	contract: Contract,
	sourceDocumentId: Id<'contractDocuments'>,
	seed: string
): NativeBuild {
	return {
		phase: 'initialize',
		documentId: sourceDocumentId,
		ancestors: [],
		command: 0,
		cursor: 0,
		headCount: 0,
		dirtyCount: 0,
		headsHash: seed,
		headsBytes: 0,
		stateCursor: null,
		stateRecords: 0,
		stateHash: seed,
		stateBytes: 0,
		playbookSelectionCount: contract.root.playbookSelectionCount,
		playbookReviewCount: contract.root.playbookReviewCount,
		playbookPendingCount: contract.root.playbookPendingCount,
		playbookDeclinedCount: contract.root.playbookDeclinedCount,
		contextChanged: false,
		documentChanged: false,
		changeIds: [],
		commandHash: seed,
		commandBytes: 0,
		commandRecords: 0,
		decisionIds: [],
		identity: ''
	};
}

export async function advanceConstruction(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	contract: Contract
) {
	const preparation = row.preparation!,
		native = structuredClone(preparation.native!);
	if (native.phase === 'validated') {
		native.phase = 'constructing';
		native.build = initialNativeBuild(contract, preparation.sourceDocumentId, native.recordsHash);
	}
	const build = native.build;
	if (!build) throw new Error('Native construction is missing its cursor.');
	if (native.phase === 'sealed') return 'sealed' as const;
	try {
		if (build.phase === 'initialize') {
			for (let turn = 0; turn < 8 && build.cursor < native.records; turn++) {
				await admitDiscussionWork(ctx, { reads: 8, queries: 8, writes: 2, bytes: 160 * 1024 });
				const record = await ctx.db
					.query('operationReceiptChunks')
					.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
						q
							.eq('receiptId', row._id)
							.eq('section', 'native-plan')
							.eq('generation', native.generation)
							.eq('order', build.cursor)
					)
					.unique();
				if (!record || hash(JSON.parse(record.data)) !== record.fingerprint)
					throw new Error('Native validated head record is incomplete.');
				const input = JSON.parse(record.data) as {
					key: string;
					head: Doc<'contractChangeHeads'> | null;
				};
				if (!(await resultRow(ctx, row, input.key))) {
					const head = input.head;
					if (head) {
						assertChangeHead(head);
						if (
							head.kind !== 'playbook' ||
							head.companyId !== row.companyId ||
							head.contractId !== contract.root._id ||
							head.key !== input.key
						)
							throw new Error('Native head snapshot has invalid ownership.');
					}
					const compact = (
						bundle: NonNullable<typeof head>['current'] | NonNullable<typeof head>['applied']
					): BuiltChange | null => {
						if (!bundle) return null;
						if (!('policy' in bundle))
							throw new Error('Native head has no bounded Playbook projection.');
						return {
							_id: bundle.changeId,
							companyId: row.companyId,
							contractId: contract.root._id,
							key: input.key,
							kind: 'playbook',
							policy: bundle.policy,
							source: { itemId: input.key as Id<'playbookItems'>, optionId: bundle.optionId }
						};
					};
					const current = compact(head?.current ?? null),
						applied = compact(head?.applied ?? null),
						currentId = currentDecisionId(head?.current ?? null),
						appliedId = appliedDecisionId(head?.applied ?? null),
						currentDecision = currentId
							? {
									_id: currentId,
									status:
										playbookStateOf(head!)!.status === 'rejected'
											? ('rejected' as const)
											: ('approved' as const)
								}
							: null,
						appliedDecision = appliedId ? { _id: appliedId, status: 'approved' as const } : null;

					await putHead(
						ctx,
						row,
						{
							key: input.key,
							stored: head ? { _id: head._id, activePlaybook: head.activePlaybook } : null,
							current,
							applied,
							currentDecision,
							appliedDecision,
							initialCurrent: current,
							initialDecision: currentDecision,
							dirty: false
						},
						build.headCount++
					);
				}
				build.cursor++;
			}
			if (build.cursor === native.records) {
				build.phase = 'command';
				build.cursor = 0;
			}
			native.unit++;
		} else if (build.phase === 'seal') {
			for (let turn = 0; turn < 8 && build.cursor < build.headCount; turn++) {
				await admitDiscussionWork(ctx, { reads: 2, queries: 2, writes: 1 });
				const head = await headAt(ctx, row, build.cursor);
				if (head.dirty) {
					build.dirtyCount++;
					const oldRequired = head.initialCurrent?.policy === 'required',
						nextRequired = head.current?.policy === 'required';
					const status = (current: BuiltHead['current'], decision: BuiltHead['currentDecision']) =>
						!current || current.policy === 'none' ? 'approved' : (decision?.status ?? 'pending');
					const active = [head.current, head.applied].some(
						(change) => change?.kind === 'playbook' && change.source.optionId !== null
					);
					build.playbookSelectionCount +=
						Number(active) - Number(head.stored?.activePlaybook ?? false);
					build.playbookReviewCount += Number(nextRequired) - Number(oldRequired);
					build.playbookPendingCount +=
						Number(nextRequired && status(head.current, head.currentDecision) === 'pending') -
						Number(oldRequired && status(head.initialCurrent, head.initialDecision) === 'pending');
					build.playbookDeclinedCount +=
						Number(nextRequired && status(head.current, head.currentDecision) === 'rejected') -
						Number(oldRequired && status(head.initialCurrent, head.initialDecision) === 'rejected');
					if (
						hash(
							oldRequired ? [head.initialCurrent!._id, head.initialDecision?._id ?? null] : null
						) !== hash(nextRequired ? [head.current!._id, head.currentDecision?._id ?? null] : null)
					)
						build.contextChanged = true;
				}
				const sealed: SealedHead = {
					key: head.key,
					storedId: head.stored?._id ?? null,
					dirty: head.dirty,
					row: finalHead(head, contract)
				};
				const chunk = await resultRow(ctx, row, head.key);
				if (!chunk) throw new Error('Native head seal lost its record.');
				const data = canonicalJson(sealed),
					fingerprint = receiptChunkFingerprint(data);
				await ctx.db.patch('operationReceiptChunks', chunk._id, { data, fingerprint });
				build.headsHash = receiptSectionHash(build.headsHash, build.cursor, fingerprint, 1);
				build.headsBytes += new TextEncoder().encode(data).length;
				build.cursor++;
			}
			if (build.cursor === build.headCount) {
				if (
					build.playbookSelectionCount < 0 ||
					build.playbookSelectionCount > MAX_SELECTED_CONCESSIONS ||
					[build.playbookReviewCount, build.playbookPendingCount, build.playbookDeclinedCount].some(
						(n) => !Number.isSafeInteger(n) || n < 0
					)
				)
					throw new Error('Invalid prepared Playbook counters.');
				const [before, after] = await Promise.all([
					ctx.db.get('contractDocuments', preparation.sourceDocumentId),
					ctx.db.get('contractDocuments', build.documentId)
				]);
				if (!before || !after) throw new Error('Native final document is missing.');
				build.documentChanged = before.fingerprint !== after.fingerprint;
				if (!build.documentChanged) build.documentId = before._id;
				build.identity = hash([
					row.key,
					native.generation,
					native.recordsHash,
					native.sourceHash,
					build.headsHash,
					build.commandHash,
					after.fingerprint,
					build.changeIds,
					build.decisionIds
				]);
				build.phase = 'state';
			}
			native.unit++;
		} else if (build.phase === 'state') {
			// The result includes completed removals. This pages only frozen-template
			// Playbook identities, independently of unlimited buyer heads and active options.
			await admitDiscussionWork(ctx, { reads: 48, queries: 48, writes: 10, bytes: 160 * 1024 });
			const page = await ctx.db
				.query('contractChangeHeads')
				.withIndex('by_contractId_and_kind', (q) =>
					q.eq('contractId', contract.root._id).eq('kind', 'playbook')
				)
				.paginate({
					cursor: build.stateCursor,
					numItems: 8,
					maximumRowsRead: 8,
					maximumBytesRead: 32 * 1024
				});
			for (const stored of page.page) {
				await admitDiscussionWork(ctx, { reads: 5, queries: 5, writes: 1, bytes: 16 * 1024 });
				const prepared = await resultRow(ctx, row, stored.key);
				let value: PlaybookState | null;
				if (prepared) {
					const head = decodeSealedHead(prepared).row;
					value = head ? playbookProjection(head) : null;
				} else value = playbookStateOf(stored);
				if (value) {
					const data = canonicalJson(value),
						fingerprint = receiptChunkFingerprint(data);
					await ctx.db.insert('operationReceiptChunks', {
						companyId: row.companyId,
						receiptId: row._id,
						section: 'native-result',
						generation: native.generation,
						order: build.headCount + build.stateRecords,
						nativeKey: `state:${stored.key}`,
						recordCount: 1,
						data,
						fingerprint
					});
					build.stateHash = receiptSectionHash(build.stateHash, build.stateRecords, fingerprint, 1);
					build.stateRecords++;
					build.stateBytes += new TextEncoder().encode(data).length;
					if (build.stateRecords > MAX_PLAYBOOK_ITEMS)
						throw new Error('Native Playbook state exceeds its frozen-template envelope.');
				}
			}
			build.stateCursor = page.continueCursor;
			if (page.isDone) {
				build.identity = hash([build.identity, build.stateHash]);
				build.phase = 'geometry';
			}
			native.unit++;
		} else {
			const job = native.jobId
				? await ctx.db.system.get('_scheduled_functions', native.jobId)
				: null;
			if (
				!job ||
				job.state.kind === 'failed' ||
				job.state.kind === 'canceled' ||
				job.state.kind === 'success'
			)
				native.jobId = await ctx.scheduler.runAfter(0, constructionAction, {
					receiptId: row._id,
					generation: native.generation,
					unit: native.unit
				});
		}
	} catch (error) {
		if (!(error instanceof DiscussionPreparationRequired)) throw error;
		native.unit++;
		native.jobId = undefined;
	}
	await ctx.db.patch('operationReceipts', row._id, {
		preparation: { ...preparation, native, dueAt: Date.now() }
	});
	return 'progress' as const;
}

export const snapshot = internalQuery({
	args: nativeOwnerArgs,
	returns: v.union(v.null(), v.string()),
	handler: async (ctx, args) => {
		const state = await constructionOwned(ctx, args);
		if (!state?.native.build || !state.access) return null;
		const { row, native, contract, access } = state,
			build = native.build!;
		const commands = commandsOf((await receiptPayload(ctx, row)).inputs),
			command = commands[build.command] ?? null;
		const chunk = command ? await resultRow(ctx, row, command.itemId) : null,
			target = chunk ? decodeHead(chunk) : null;
		const scan =
			build.cursor < build.headCount && ['compare', 'compare-own'].includes(build.phase)
				? await headAt(ctx, row, build.cursor)
				: null;
		const item = command
			? await (await contractReader(ctx, contract.root)).item(command.itemId)
			: null;
		const optionId = command?.action.kind === 'set' ? command.action.optionId : null;
		const option =
			optionId !== null ? item?.choices.find((choice) => choice.id === optionId) : null;
		const source =
			command?.action.kind === 'set' && item
				? {
						templateVersionId: contract.root.templateVersionId,
						itemId: command.itemId,
						optionId: command.action.optionId,
						description: option?.description ?? 'Remove applied option',
						target: item.primary.target
					}
				: null;
		const value: ConstructionSnapshot = {
			build,
			command,
			target,
			scan,
			commandKey: command ? actionKey(access, 'application', command.id) : null,
			approve: item?.review.kind === 'none' || access.membership.role === 'admin',
			policy: item?.review.kind ?? 'required',
			source,
			changes: option?.changes ?? [],
			actor: changeActorOf(access),
			createdAt: row._creationTime + build.command
		};
		return JSON.stringify(value);
	}
});

type ArtifactKind =
	'source' | 'current' | 'base' | 'candidate' | 'comparison' | 'predecessor' | 'patch' | 'other';
export const artifactKind = v.union(
	...(
		[
			'source',
			'current',
			'base',
			'candidate',
			'comparison',
			'predecessor',
			'patch',
			'other'
		] as const
	).map((kind) => v.literal(kind))
);
async function artifactRow(
	ctx: QueryCtx,
	state: NonNullable<Awaited<ReturnType<typeof constructionOwned>>>,
	kind: ArtifactKind
) {
	const b = state.native.build!;
	let id: Id<'contractDocuments'> | Id<'contractChanges'> | undefined;
	if (kind === 'source') id = state.row.preparation!.sourceDocumentId;
	else if (kind === 'current') id = b.documentId;
	else if (kind === 'base') id = b.baseDocumentId;
	else if (kind === 'candidate') id = b.candidateDocumentId;
	else if (kind === 'comparison') id = b.comparisonDocumentId;
	else if (kind === 'predecessor') id = b.predecessorId;
	else if (kind === 'patch') id = b.changeId;
	else if (state.row.kind === 'playbook-save')
		id = (await headAt(ctx, state.row, b.cursor)).current?._id;
	else {
		const chunk = await ctx.db
			.query('operationReceiptChunks')
			.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
				q
					.eq('receiptId', state.row._id)
					.eq('section', 'native-result')
					.eq('generation', state.native.generation)
					.eq('order', b.cursor)
			)
			.unique();
		if (!chunk || receiptChunkFingerprint(chunk.data) !== chunk.fingerprint)
			throw new Error('Authority comparison cursor is incomplete.');
		id = (JSON.parse(chunk.data) as { row: Doc<'contractChangeHeads'> | null }).row?.current
			?.changeId;
	}
	if (!id) throw new Error('Native artifact cursor has no source.');
	const table = ['predecessor', 'patch', 'other'].includes(kind)
		? 'contractChanges'
		: 'contractDocuments';
	const row =
		table === 'contractChanges'
			? await ctx.db.get('contractChanges', id as Id<'contractChanges'>)
			: await ctx.db.get('contractDocuments', id as Id<'contractDocuments'>);
	if (!row || row.companyId !== state.row.companyId || row.contractId !== state.contract.root._id)
		throw new Error('Native artifact ownership failed.');
	if (row.stage?.receiptId === state.row._id && row.stage.generation === state.native.generation) {
		if (!row.stage.sealed || row.stage.unit > state.native.unit)
			throw new Error('Native artifact is unsealed.');
	} else await requireNativeReachability(ctx, table, row._id, row);
	return row;
}
export const artifact = internalQuery({
	args: { ...nativeOwnerArgs, kind: artifactKind },
	returns: v.union(v.null(), schema.doc('contractDocuments'), schema.doc('contractChanges')),
	handler: async (ctx, args) => {
		const state = await constructionOwned(ctx, args);
		return state?.native.build ? artifactRow(ctx, state, args.kind) : null;
	}
});
export const artifactPage = internalQuery({
	args: { ...nativeOwnerArgs, kind: artifactKind, offset: v.number() },
	returns: v.union(
		v.null(),
		v.array(schema.doc('contractDocumentChunks')),
		v.array(schema.doc('contractChangeContents'))
	),
	handler: async (ctx, args) => {
		const state = await constructionOwned(ctx, args);
		if (!state?.native.build) return null;
		if (!Number.isSafeInteger(args.offset) || args.offset < 0)
			throw new Error('Invalid native artifact page.');
		const row = await artifactRow(ctx, state, args.kind);
		if ('chunkIds' in row) {
			const page = await Promise.all(
				row.chunkIds
					.slice(args.offset, args.offset + 4)
					.map((id) => ctx.db.get('contractDocumentChunks', id))
			);
			if (
				page.some(
					(chunk) =>
						!chunk || chunk.companyId !== row.companyId || chunk.contractId !== row.contractId
				)
			)
				throw new Error('Native document page is incomplete.');
			return page as Doc<'contractDocumentChunks'>[];
		}
		const page = await ctx.db
			.query('contractChangeContents')
			.withIndex('by_changeId_and_order', (q) =>
				q.eq('changeId', row._id).gte('order', args.offset)
			)
			.take(Math.min(4, row.chunks - args.offset));
		if (
			page.length !== Math.min(4, row.chunks - args.offset) ||
			page.some(
				(part, i) =>
					part.order !== args.offset + i ||
					part.companyId !== row.companyId ||
					part.contractId !== row.contractId
			)
		)
			throw new Error('Native patch page is incomplete.');
		return page;
	}
});

const checkpointValue = v.union(
	v.object({ kind: v.literal('start') }),
	v.object({ kind: v.literal('reversed'), documentId: v.id('contractDocuments') }),
	v.object({
		kind: v.literal('patched'),
		documentId: v.id('contractDocuments'),
		changeId: v.id('contractChanges')
	}),
	v.object({
		kind: v.literal('compared'),
		incompatible: v.boolean(),
		documentId: v.optional(v.id('contractDocuments'))
	}),
	v.object({ kind: v.literal('compared-own') }),
	v.object({ kind: v.literal('finish') })
);
async function sealedUpload(
	ctx: MutationCtx,
	state: NonNullable<Awaited<ReturnType<typeof constructionOwned>>>,
	id: Id<'contractDocuments'>,
	slot: string
) {
	const row = await ctx.db.get('contractDocuments', id),
		stage = row?.stage;
	if (
		!row ||
		!stage ||
		stage.receiptId !== state.row._id ||
		stage.generation !== state.native.generation ||
		stage.unit !== state.native.unit ||
		stage.slot !== slot ||
		!stage.sealed ||
		stage.written !== row.chunkHashes.length ||
		row.companyId !== state.row.companyId ||
		row.contractId !== state.contract.root._id
	)
		throw new Error('Native checkpoint has no exact sealed document.');
	return row;
}
export const checkpoint = internalMutation({
	args: { ...nativeOwnerArgs, value: checkpointValue },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await constructionOwned(ctx, args);
		if (!state?.native.build || !state.access) return null;
		if (await expireOperation(ctx, state.row)) return null;
		const { row, contract, access } = state,
			native = structuredClone(state.native),
			b = native.build!,
			value = args.value;
		const commands = commandsOf((await receiptPayload(ctx, row)).inputs),
			command = commands[b.command];
		await admitDiscussionWork(ctx, { reads: 12, queries: 12, writes: 4, bytes: 256 * 1024 });
		const stored = command ? await resultRow(ctx, row, command.itemId) : null,
			target = stored ? decodeHead(stored) : null;
		const policy = command
			? (await (await contractReader(ctx, contract.root)).item(command.itemId))?.review.kind
			: null;
		const approve = policy === 'none' || access.membership.role === 'admin';
		if (value.kind === 'start') {
			if (b.phase !== 'command') throw new Error('Native command cursor changed.');
			if (!command) {
				b.phase = 'seal';
				b.cursor = 0;
			} else {
				if (!target) throw new Error('Native command has no validated head.');
				let noop = false;
				if (command.action.kind === 'withdraw') {
					if (target.current?._id === target.applied?._id && target.current)
						throw new ConvexError('Use a reviewed removal to remove applied wording.');
					if (target.current) {
						target.current = target.applied;
						target.currentDecision = target.appliedDecision;
						target.dirty = true;
						await putHead(ctx, row, target);
					}
					noop = true;
				} else if (
					target.current?.kind === 'playbook' &&
					target.current.source.optionId === command.action.optionId &&
					(target.current.policy === 'none' || target.currentDecision?.status !== 'rejected')
				)
					noop = true;
				else if (command.action.optionId === null && !target.applied) {
					if (target.current)
						throw new ConvexError(
							'Withdraw the pending transition to return to the applied wording.'
						);
					noop = true;
				}
				if (noop) {
					await sealCommand(ctx, row, b, command, null);
					b.command++;
				} else {
					b.baseDocumentId = b.documentId;
					b.predecessorId = target.applied?._id;
					b.ancestors = [];
					b.phase = b.predecessorId ? 'reverse' : 'patch';
				}
			}
		} else if (value.kind === 'reversed') {
			if (b.phase !== 'reverse' || !b.predecessorId)
				throw new Error('Native reversal cursor changed.');
			await sealedUpload(ctx, state, value.documentId, 'reverse');
			const predecessor = await artifactRow(ctx, state, 'predecessor');
			if (
				!('patchKey' in predecessor) ||
				predecessor.kind !== 'playbook' ||
				predecessor.key !== command.itemId ||
				b.ancestors.includes(predecessor._id) ||
				b.ancestors.length >= MAX_APPROVED_CHANGE_CHAIN
			)
				throw new Error('Invalid native reversal predecessor.');
			b.ancestors.push(predecessor._id);
			b.baseDocumentId = value.documentId;
			b.predecessorId = predecessor.predecessorId;
			if (!b.predecessorId) b.phase = 'patch';
		} else if (value.kind === 'patched') {
			if (b.phase !== 'patch' || !target) throw new Error('Native patch cursor changed.');
			if (b.ancestors.length >= MAX_APPROVED_CHANGE_CHAIN)
				throw new ConvexError('This widget has too many wording revisions.');
			await sealedUpload(ctx, state, value.documentId, 'candidate');
			const change = await ctx.db.get('contractChanges', value.changeId),
				stage = change?.stage;
			if (
				!change ||
				!stage ||
				stage.receiptId !== row._id ||
				stage.generation !== native.generation ||
				stage.unit !== native.unit ||
				!stage.sealed ||
				stage.written !== change.chunks ||
				change.key !== command.itemId ||
				change.operationId !== actionKey(access, 'application', command.id) ||
				change.predecessorId !== target.applied?._id
			)
				throw new Error('Native change checkpoint ownership failed.');
			b.changeId = change._id;
			b.candidateDocumentId = value.documentId;
			b.changeIds.push(change._id);
			b.cursor = 0;
			b.phase = 'compare';
		} else if (value.kind === 'compared') {
			if (b.phase !== 'compare' || !target)
				throw new Error('Native Playbook comparison cursor changed.');
			if (b.cursor >= b.headCount) b.phase = 'finish';
			else {
				const other = await headAt(ctx, row, b.cursor);
				const pending =
					other.key !== target.key &&
					other.current &&
					other.current._id !== other.applied?._id &&
					other.current.policy === 'required' &&
					other.currentDecision?.status !== 'approved';
				if (pending && value.incompatible) {
					if (!approve)
						throw new ConvexError('Another pending Playbook option overlaps this wording.');
					other.current = other.applied;
					other.currentDecision = other.appliedDecision;
					other.dirty = true;
					await putHead(ctx, row, other);
				}
				if (pending && !approve && !value.incompatible) {
					if (!value.documentId)
						throw new Error('Native overlap check has no intermediate document.');
					await sealedUpload(ctx, state, value.documentId, 'comparison');
					b.comparisonDocumentId = value.documentId;
					b.phase = 'compare-own';
				} else b.cursor++;
			}
		} else if (value.kind === 'compared-own') {
			if (b.phase !== 'compare-own')
				throw new Error('Native reverse-order overlap cursor changed.');
			b.comparisonDocumentId = undefined;
			b.cursor++;
			b.phase = 'compare';
		} else {
			if (b.phase !== 'finish' || !target || !b.changeId || !b.candidateDocumentId)
				throw new Error('Native command finish cursor changed.');
			const change = await ctx.db.get('contractChanges', b.changeId);
			if (!change) throw new Error('Prepared change disappeared.');
			target.current = compactChange(change);
			target.currentDecision = null;
			target.dirty = true;
			if (approve) {
				target.applied = compactChange(change);
				target.appliedDecision = null;
				b.documentId = b.candidateDocumentId;
				if (change.policy === 'required') {
					const decisionId = await ctx.db.insert('contractChangeDecisions', {
						companyId: row.companyId,
						contractId: contract.root._id,
						changeId: change._id,
						actor: changeActorOf(access),
						operationId: change.operationId,
						action: 'approve',
						status: 'approved',
						decidedAt: change.createdAt,
						stage: {
							receiptId: row._id,
							generation: native.generation,
							unit: native.unit,
							slot: 'decision',
							sealed: true,
							written: 1
						}
					});
					target.currentDecision = target.appliedDecision = { _id: decisionId, status: 'approved' };
					b.decisionIds.push(decisionId);
				}
			}
			await putHead(ctx, row, target);
			await sealCommand(ctx, row, b, command, change, target.currentDecision?._id ?? null);
			b.command++;
			b.phase = 'command';
			b.cursor = 0;
			b.baseDocumentId = undefined;
			b.candidateDocumentId = undefined;
			b.changeId = undefined;
			b.ancestors = [];
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

export const geometry = internalMutation({
	args: {
		...nativeOwnerArgs,
		manifest: transitionManifest,
		offset: v.number(),
		total: v.number(),
		splices: v.array(discussionSplice),
		done: v.boolean()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const state = await constructionOwned(ctx, args);
		if (!state?.native.build) return false;
		if (await expireOperation(ctx, state.row)) return false;
		const { row } = state,
			native = structuredClone(state.native),
			b = native.build!;
		if (
			b.phase !== 'geometry' ||
			args.splices.length > DISCUSSION_MAP_CHUNK_SPLICES ||
			!Number.isSafeInteger(args.offset) ||
			args.offset < 0 ||
			!Number.isSafeInteger(args.total) ||
			args.total !== args.manifest.spliceCount ||
			args.offset % DISCUSSION_MAP_CHUNK_SPLICES !== 0 ||
			args.total < 0 ||
			args.manifest.mapKey !== `discussion:${args.manifest.geometryHash}`
		)
			throw new Error('Invalid native geometry cursor.');
		const p = structuredClone(row.preparation!);
		if (
			p.map &&
			(p.map.geometryHash !== args.manifest.geometryHash ||
				p.map.chunkHash !== args.manifest.chunkHash ||
				p.map.spliceCount !== args.manifest.spliceCount ||
				p.map.beforeLength !== args.manifest.beforeLength ||
				p.map.afterLength !== args.manifest.afterLength)
		)
			throw new Error('Native geometry identity changed.');
		await admitDiscussionWork(ctx, { reads: 4, queries: 4, writes: 4, bytes: 16 * 1024 });
		const cursor = args.manifest.inline
			? p.mapCursor
			: await acquireDiscussionMap(
					ctx,
					{
						companyId: row.companyId,
						contractId: state.contract.root._id
					},
					args.manifest,
					p.mapCursor
				);
		if (cursor && args.offset > cursor.splice) {
			// A partial retired map must replay its prefix from zero. Keep this exact
			// generation/unit alive; the next bounded action reuses the original owner.
			await ctx.db.patch('operationReceipts', row._id, {
				preparation: { ...p, map: args.manifest, mapCursor: cursor, dueAt: Date.now() }
			});
			await ensureDiscussionMaintenance(ctx, state.contract.root._id);
			return false;
		}
		p.map = args.manifest;
		if (!args.manifest.inline && args.splices.length) {
			if (
				!cursor ||
				args.splices.length !== Math.min(DISCUSSION_MAP_CHUNK_SPLICES, args.total - args.offset)
			)
				throw new Error('Native geometry chunk boundary changed.');
			const first = args.splices[0],
				last = args.splices.at(-1)!;
			let before = first.beforeStart,
				after = first.afterStart;
			const displacement = after - before;
			if (args.offset === cursor.splice && displacement !== cursor.displacement)
				throw new Error('Native geometry displacement changed.');
			for (const splice of args.splices) {
				if (
					splice.beforeStart < before ||
					splice.afterStart < after ||
					splice.beforeEnd < splice.beforeStart ||
					splice.afterEnd < splice.afterStart ||
					splice.beforeStart - before !== splice.afterStart - after
				)
					throw new Error('Native geometry page is not monotone.');
				before = splice.beforeEnd;
				after = splice.afterEnd;
			}
			const chunk = {
				companyId: row.companyId,
				contractId: state.contract.root._id,
				mapKey: args.manifest.mapKey,
				firstBefore: first.beforeStart,
				startingDisplacement: displacement,
				splices: args.splices
			};
			await stageDiscussionMapChunk(ctx, chunk);
			// Action retries replay every prefix page. Verify/reacquire its exact row
			// without counting it twice or trusting a page that has disappeared.
			if (args.offset < cursor.splice) return true;
			cursor.hash = discussionMapChunkHash(cursor.hash, cursor.chunkCount, chunk);
			cursor.splice += args.splices.length;
			cursor.chunkCount++;
			cursor.bytes += getConvexSize(chunk);
			cursor.displacement = last.afterEnd - last.beforeEnd;
		}
		p.mapCursor = cursor;
		if (args.done) {
			if (!args.manifest.inline && cursor)
				p.map = { ...args.manifest, chunkCount: cursor.chunkCount, bytes: cursor.bytes };
			if (!sealedDiscussionMap(p.map, cursor))
				throw new Error('Native geometry seal is incomplete.');
			b.phase = 'sealed';
			native.phase = 'sealed';
			native.unit++;
			native.jobId = undefined;
			p.nativePlanPending = false;
			p.planIdentity = b.identity;
			p.proofIdentity = b.identity;
			p.proofComplete = false;
			p.supportComplete = false;
			p.proofCursor = { cohort: 0, frames: [] };
			p.supportCursor = { geometry: { cohort: 0, frames: [] }, counts: emptySupportCounts() };
		}
		p.native = native;
		p.dueAt = Date.now();
		await ctx.db.patch('operationReceipts', row._id, { preparation: p });
		await ensureDiscussionMaintenance(ctx, state.contract.root._id);
		return true;
	}
});

/** Proof resets are independent of the sealed native construction and geometry. */
export async function advanceNativeProof(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	contract: Contract
) {
	const p = structuredClone(row.preparation!),
		b = p.native!.build!;
	if (
		p.nativePlanPending ||
		p.native!.phase !== 'sealed' ||
		b.phase !== 'sealed' ||
		!p.map ||
		!sealedDiscussionMap(p.map, p.mapCursor)
	)
		throw new Error('Native construction is not sealed.');
	const index = await DiscussionIndex.open(ctx, contract.root);
	const live =
		b.documentChanged &&
		Boolean(
			index.events.length ||
			(await ctx.db
				.query('discussionThreads')
				.withIndex('by_contractId_and_tombstoned_and_indexedDocumentRevision', (q) =>
					q.eq('contractId', contract.root._id).eq('tombstoned', false)
				)
				.first())
		);
	if (!live) {
		p.proofComplete = true;
		p.supportComplete = true;
		p.witnessThreadId = index.control?.witnessThreadId ?? null;
		p.supportCursor = {
			geometry: { cohort: 0, frames: [] },
			counts: {
				supportCount: index.supportSummary.supportCount,
				pendingCount: index.supportSummary.pendingCount,
				declinedCount: index.supportSummary.declinedCount,
				withAppliedCount: index.supportSummary.withAppliedCount,
				coveredPendingCount: index.supportSummary.coveredPendingCount
			}
		};
	} else {
		if (index.events.length >= 8) return false;
		if (p.indexGeneration !== index.indexGeneration) {
			p.proofComplete = false;
			p.proofCursor = { cohort: 0, frames: [] };
			p.witnessThreadId = null;
		}
		if (
			p.supportGeneration !== index.supportIndexGeneration ||
			p.storageGeneration !== index.nativeStorageGeneration ||
			p.requestId !== (index.supportSummary.request?.id ?? null) ||
			p.requestCutoff !== (index.supportSummary.request?.cutoff ?? null)
		) {
			p.supportComplete = false;
			p.supportCursor = { geometry: { cohort: 0, frames: [] }, counts: emptySupportCounts() };
		}
		try {
			for (let step = 0; step < 16 && !p.proofComplete; step++) {
				await admitDiscussionWork(ctx, { reads: 16, queries: 16 });
				const proof = await index.proofStep(p.proofCursor, p.map, []);
				p.proofCursor = proof.cursor;
				p.proofComplete = proof.done;
				p.witnessThreadId = proof.witness;
			}
			for (let step = 0; step < 16 && !p.supportComplete; step++) {
				await admitDiscussionWork(ctx, { reads: 16, queries: 16 });
				const proof = await index.supportProofStep(p.supportCursor, p.map, []);
				p.supportCursor = proof.cursor;
				p.supportComplete = proof.done;
			}
		} catch (error) {
			if (!(error instanceof DiscussionPreparationRequired)) throw error;
		}
	}
	p.indexGeneration = index.indexGeneration;
	p.supportGeneration = index.supportIndexGeneration;
	p.storageGeneration = index.nativeStorageGeneration;
	p.requestId = index.supportSummary.request?.id ?? null;
	p.requestCutoff = index.supportSummary.request?.cutoff ?? null;
	p.dueAt = Date.now();
	await ctx.db.patch('operationReceipts', row._id, { preparation: p });
	// Adoption runs in a fresh turn so proof work cannot consume its final write/read budget.
	return p.proofComplete && p.supportComplete;
}
function finalHead(head: BuiltHead, contract: Contract) {
	return createChangeHead({
		companyId: contract.root.companyId,
		contractId: contract.root._id,
		kind: 'playbook',
		key: head.key,
		current: head.current
			? {
					changeId: head.current._id,
					change: head.current,
					decisionId: head.currentDecision?._id,
					admissionRevision: contract.root.stateRevision + 1
				}
			: null,
		applied: head.applied
			? {
					changeId: head.applied._id,
					change: head.applied,
					decisionId: head.appliedDecision?._id
				}
			: null
	});
}
/** Only sealed immutable references and bounded native writes enter this transaction. */
export async function adoptNativeSave(ctx: MutationCtx, row: Doc<'operationReceipts'>) {
	const liveOwner = await nativeAdoptionOwner(ctx, row);
	if (!liveOwner) return true;
	row = liveOwner;
	if (await expireOperation(ctx, row)) return true;
	const { contract, access } = await authorizePreparedOperation(ctx, row);
	if (!access || !(await nativeValidationCurrent(ctx, row, contract))) return false;
	await requireContractWork(ctx, contract);
	const p = row.preparation!,
		native = p.native!,
		b = native.build!;
	if (
		native.phase !== 'sealed' ||
		b.phase !== 'sealed' ||
		p.nativePlanPending ||
		!p.proofComplete ||
		!p.supportComplete ||
		!p.map ||
		!sealedDiscussionMap(p.map, p.mapCursor)
	)
		throw new Error('Native result has no adoption seal.');
	const index = await DiscussionIndex.open(ctx, contract.root);
	if (
		p.indexGeneration !== index.indexGeneration ||
		p.supportGeneration !== index.supportIndexGeneration ||
		p.storageGeneration !== index.nativeStorageGeneration ||
		p.requestId !== (index.supportSummary.request?.id ?? null) ||
		p.requestCutoff !== (index.supportSummary.request?.cutoff ?? null)
	)
		return false;
	const live =
		b.documentChanged &&
		Boolean(
			index.events.length ||
			(await ctx.db
				.query('discussionThreads')
				.withIndex('by_contractId_and_tombstoned_and_indexedDocumentRevision', (q) =>
					q.eq('contractId', contract.root._id).eq('tombstoned', false)
				)
				.first())
		);
	if (live && index.events.length >= 8) return false;
	const payload = await receiptPayload(ctx, row),
		commands = commandsOf(payload.inputs);
	// The sealed head set is bounded by the selected Playbook envelope plus direct commands.
	// No buyer support or source patch is read here.
	const chunks = await ctx.db
		.query('operationReceiptChunks')
		.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
			q
				.eq('receiptId', row._id)
				.eq('section', 'native-result')
				.eq('generation', native.generation)
				.gte('order', 0)
				.lt('order', b.headCount)
		)
		.take(MAX_SELECTED_CONCESSIONS + MAX_SAVE_COMMANDS + 1);
	if (chunks.length !== b.headCount || chunks.length > MAX_SELECTED_CONCESSIONS + MAX_SAVE_COMMANDS)
		throw new Error('Native result head seal is incomplete.');
	let digest = native.recordsHash,
		bytes = 0;
	const heads = chunks.map((chunk, i) => {
		if (chunk.order !== i || chunk.companyId !== row.companyId)
			throw new Error('Native result order changed.');
		const head = decodeSealedHead(chunk);
		digest = receiptSectionHash(digest, i, hash(head), 1);
		bytes += new TextEncoder().encode(chunk.data).length;
		return head;
	});
	if (
		digest !== b.headsHash ||
		bytes !== b.headsBytes ||
		heads.filter((head) => head.dirty).length !== b.dirtyCount
	)
		throw new Error('Native result head seal changed.');
	const stateChunks = await ctx.db
		.query('operationReceiptChunks')
		.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
			q
				.eq('receiptId', row._id)
				.eq('section', 'native-result')
				.eq('generation', native.generation)
				.gte('order', b.headCount)
		)
		.take(MAX_PLAYBOOK_ITEMS + 1);
	if (stateChunks.length !== b.stateRecords || stateChunks.length > MAX_PLAYBOOK_ITEMS)
		throw new Error('Native replay state seal is incomplete.');
	let stateHash = native.recordsHash,
		stateBytes = 0;
	const states = new Map<string, PlaybookState>();
	for (const [i, chunk] of stateChunks.entries()) {
		if (
			chunk.order !== b.headCount + i ||
			chunk.companyId !== row.companyId ||
			receiptChunkFingerprint(chunk.data) !== chunk.fingerprint
		)
			throw new Error('Native replay state order/integrity changed.');
		stateHash = receiptSectionHash(stateHash, i, chunk.fingerprint, 1);
		stateBytes += new TextEncoder().encode(chunk.data).length;
		const value = JSON.parse(chunk.data) as PlaybookState;
		states.set(value.itemId, value);
	}
	if (stateHash !== b.stateHash || stateBytes !== b.stateBytes)
		throw new Error('Native replay state seal changed.');
	for (const head of heads) {
		const state = head.row ? playbookProjection(head.row) : null;
		if (state) states.set(state.itemId, state);
		else states.delete(head.key);
	}
	const playbook = [...states.values()];
	const commandChunks = await ctx.db
		.query('operationReceiptChunks')
		.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
			q
				.eq('receiptId', row._id)
				.eq('section', 'native-result')
				.eq('generation', native.generation)
				.lt('order', 0)
		)
		.order('desc')
		.take(MAX_SAVE_COMMANDS + 1);
	if (commandChunks.length !== commands.length || b.commandRecords !== commands.length)
		throw new Error('Native command manifests are incomplete.');
	let commandHash = native.recordsHash,
		manifestBytes = 0;
	const commandManifests = commandChunks.map((chunk, i) => {
		if (
			chunk.order !== -i - 1 ||
			chunk.nativeKey !== `command:${i}` ||
			chunk.companyId !== row.companyId ||
			chunk.recordCount !== 1 ||
			receiptChunkFingerprint(chunk.data) !== chunk.fingerprint
		)
			throw new Error('Native command manifest ownership/order/integrity failed.');
		const value = JSON.parse(chunk.data) as SealedCommand;
		if (value.commandId !== commands[i].id)
			throw new Error('Native command manifest input changed.');
		commandHash = receiptSectionHash(commandHash, i, chunk.fingerprint, 1);
		manifestBytes += new TextEncoder().encode(chunk.data).length;
		return value;
	});
	if (
		commandHash !== b.commandHash ||
		manifestBytes !== b.commandBytes ||
		canonicalJson(commandManifests.flatMap((m) => (m.change ? [m.change.id] : []))) !==
			canonicalJson(b.changeIds) ||
		canonicalJson(commandManifests.flatMap((m) => (m.decisionId ? [m.decisionId] : []))) !==
			canonicalJson(b.decisionIds)
	)
		throw new Error('Native command seal changed.');
	const now = Date.now(),
		buyerChanged = live && p.supportCursor.counts.supportCount < index.supportSummary.supportCount;
	const rootFields = {
		documentId: b.documentId,
		documentRevision: contract.root.documentRevision + Number(b.documentChanged),
		stateRevision: contract.root.stateRevision + Number(b.dirtyCount > 0),
		savedAt: b.dirtyCount ? now : contract.root.savedAt,
		playbookSelectionCount: b.playbookSelectionCount,
		playbookReviewCount: b.playbookReviewCount,
		playbookPendingCount: b.playbookPendingCount,
		playbookDeclinedCount: b.playbookDeclinedCount,
		...(b.dirtyCount
			? { lastOperation: { id: row.operationId!, callerId: access.profile._id } }
			: {}),
		reviews: {
			playbook: b.contextChanged
				? (() => {
						const identity = contextIdentity([
							contract.root.reviews.playbook.identity,
							access.membershipId,
							row.operationId,
							b.identity
						]);
						return {
							identity,
							completion: changedContextCompletion(
								identity,
								b.playbookReviewCount,
								b.playbookPendingCount,
								access
							)
						};
					})()
				: contract.root.reviews.playbook,
			buyerLink: buyerChanged
				? (() => {
						const identity = contextIdentity([
							contract.root.reviews.buyerLink.identity,
							access.membershipId,
							row.operationId,
							b.identity,
							p.supportCursor.counts
						]);
						return {
							identity,
							completion: changedContextCompletion(
								identity,
								index.supportSummary.appliedBuyerCount +
									p.supportCursor.counts.supportCount -
									p.supportCursor.counts.withAppliedCount,
								p.supportCursor.counts.pendingCount,
								access
							)
						};
					})()
				: contract.root.reviews.buyerLink
		}
	};
	const directory = await ctx.db
		.query('contractDirectory')
		.withIndex('by_contractId', (q) => q.eq('contractId', contract.root._id))
		.unique();
	if (!directory) throw new Error('Native adoption lost the contract directory.');
	const measured = (value: Record<string, unknown>) =>
		getConvexSize(
			Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined)) as Value
		) + 128;
	const rootBytes = measured({ ...contract.root, ...rootFields }),
		directoryBytes = measured({
			...directory,
			savedAt: rootFields.savedAt,
			...(live ? { hasUnreadComment: Boolean(p.witnessThreadId) } : {})
		});
	const nativeBytes = heads.filter((h) => h.dirty).reduce((n, h) => n + measured(h.row ?? {}), 0);
	const nextRoot = { ...contract.root, ...rootFields };
	const result = {
		status: 'saved' as const,
		state: {
			title: nextRoot.title,
			documentId: nextRoot.documentId,
			documentRevision: nextRoot.documentRevision,
			stateRevision: nextRoot.stateRevision,
			reviews: nextRoot.reviews,
			playbook,
			hubspot: contract.hubspot,
			lastOperationId: nextRoot.lastOperation?.id ?? null
		}
	};
	const resultBytes = JSON.stringify(result);
	const nativeResult = {
		generation: native.generation,
		identity: b.identity,
		documentId: b.documentId,
		changeIds: b.changeIds,
		decisionIds: b.decisionIds
	};
	const sealWork = await receiptSealWork(
		ctx,
		{ ...row, nativeResult },
		payload.inputs,
		resultBytes
	);
	// Reserve actual encoded known rows, ordinary receipt chunk deletion/rewrite,
	// bounded activity details and the focused control/event/scheduling/pointer group.
	// Query/read reserves include final replay state; no late patch/document hydration.
	const receiptBytes = sealWork.bytes + documentBytes({ ...row, nativeResult });
	const commandPlans = commands.map((command) =>
		planReceiptWrite(
			row.companyId,
			actionKey(access, 'application', command.id),
			JSON.stringify([contract.root._id, command]),
			row.operationId!
		)
	);
	const activityRows: Omit<Doc<'hubspotEvents'>, '_id' | '_creationTime'>[] = [];
	for (const [i, command] of commands.entries()) {
		const key = actionKey(access, 'application', command.id),
			manifest = commandManifests[i];
		const existing = await ctx.db
			.query('operationReceipts')
			.withIndex('by_key', (q) => q.eq('key', key))
			.unique();
		if (existing)
			throw new ConvexError(
				'This contract change was already accepted. Reload before applying it again.'
			);
		if (manifest.activityDetail !== null) {
			const prepared = await prepareActivity(
				ctx,
				contract,
				actorOf(access.profile),
				key,
				'applied',
				manifest.activityDetail,
				Math.min(now, command.occurredAt)
			);
			if (prepared.row) activityRows.push(prepared.row);
		}
	}
	const document = await ctx.db.get('contractDocuments', b.documentId);
	if (
		!document ||
		document.companyId !== row.companyId ||
		document.contractId !== contract.root._id
	)
		throw new Error('Native adopted document owner changed.');
	if (document.stage?.receiptId === row._id) {
		if (document.stage.generation !== native.generation || !document.stage.sealed)
			throw new Error('Native adopted document stage changed.');
	} else await requireNativeReachability(ctx, 'contractDocuments', document._id, document);
	const buyerCurrent = await prepareBuyerCurrentView(
		ctx,
		contract.root,
		{ ...contract.root, ...rootFields },
		document.fingerprint
	);
	const commandBytes =
			commandPlans.reduce((n, plan) => n + plan.work.bytes, 0) +
			activityRows.reduce(
				(n, value) => n + documentBytes({ ...value, _id: 'x'.repeat(32), _creationTime: 0 }),
				0
			),
		commandWrites =
			commandPlans.reduce((n, plan) => n + plan.work.documents, 0) + activityRows.length;

	const metrics = await ctx.meta.getTransactionMetrics();
	const controlBytes = measured(index.control ?? {}) + 32 * 1024,
		eventBytes = measured({
			companyId: row.companyId,
			contractId: contract.root._id,
			fromRevision: contract.root.documentRevision,
			toRevision: contract.root.documentRevision + 1,
			map: p.map ?? null
		});
	if (
		metrics.documentsWritten.remaining <
			b.dirtyCount + commandWrites + sealWork.writes + (buyerCurrent.work.documents ?? 0) + 12 ||
		metrics.bytesWritten.remaining <
			nativeBytes +
				rootBytes +
				directoryBytes +
				receiptBytes +
				commandBytes +
				controlBytes +
				eventBytes +
				(buyerCurrent.work.bytes ?? 0) +
				128 * 1024 ||
		metrics.databaseQueries.remaining <
			commands.length * 6 + (buyerCurrent.work.queries ?? 0) + 80 ||
		metrics.documentsRead.remaining < commands.length * 6 + sealWork.reads + 80 ||
		metrics.bytesRead.remaining < sealWork.readBytes + 128 * 1024 ||
		metrics.functionsScheduled.remaining < 2 ||
		metrics.scheduledFunctionArgsBytes.remaining < 8192
	)
		throw new DiscussionPreparationRequired('capacity');
	for (const head of heads)
		if (head.dirty) {
			const value = head.row;
			if (!value) {
				if (head.storedId) await ctx.db.delete('contractChangeHeads', head.storedId);
			} else if (head.storedId) await ctx.db.replace('contractChangeHeads', head.storedId, value);
			else await ctx.db.insert('contractChangeHeads', value);
		}
	if (live) {
		index.installSupportCounts(p.supportCursor.counts);
		await index.recordTransition(ctx, p.map!);
		await index.flush(
			ctx,
			p.witnessThreadId,
			await scheduleDiscussionMaintenance(ctx, index),
			false
		);
	}
	await patchContract(ctx, contract, rootFields, {
		...(live ? { hasUnreadComment: Boolean(p.witnessThreadId) } : {}),
		directoryRow: directory,
		buyerCurrent
	});
	// Publish exact immutable reachability in the same transaction as the root/heads/result.
	await ctx.db.patch('operationReceipts', row._id, {
		nativeResult: {
			generation: native.generation,
			identity: b.identity,
			documentId: b.documentId,
			changeIds: b.changeIds,
			decisionIds: b.decisionIds
		}
	});
	for (const value of activityRows) await ctx.db.insert('hubspotEvents', value);
	for (const command of commands)
		await remember(
			ctx,
			row.companyId,
			actionKey(access, 'application', command.id),
			JSON.stringify([contract.root._id, command]),
			row.operationId!
		);
	// A compact state is supplied from the prepared native heads rather than rehydrating them.
	await sealReceipt(ctx, row, payload.inputs, { state: 'complete', result: resultBytes });
	return true;
}
