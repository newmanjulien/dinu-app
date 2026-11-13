import { prepareBuyerCurrentView } from './buyerCurrent';
import { ConvexError, getConvexSize, v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import type { Contract } from './contractState';
import { patchContract } from './contractState';
import {
	type AuthorityInput,
	authorityTarget,
	prepareAuthorityActivity,
	runAuthority
} from './contractAuthority';
import {
	initialNativeBuild,
	constructionOwned,
	nativeOwnerArgs,
	type NativeOwner,
	type NativeBuild,
	advanceNativeProof
} from './nativeConstruction';
import { nativeValidationCurrent } from './nativePlanPreparation';
import { authorizePreparedOperation } from './discussionPreparation';
import {
	changeActorOf,
	effectiveDecision,
	readChangeRow,
	playbookStateOf
} from './contractChanges';
import { DiscussionIndex } from './discussionIndex';
import { prepareBuyerHeadEffects } from './discussionTransitions';
import { prepareProposalClaim } from './discussionClaims';
import { effectiveBuyerSource } from './buyerSupportEligibility';
import {
	admitDiscussionWork,
	DiscussionPreparationRequired,
	sealedDiscussionMap
} from './discussionMaps';
import {
	ensureDiscussionMaintenance,
	scheduleDiscussionMaintenance
} from './discussionMaintenance';
import {
	receiptPayload,
	receiptChunkFingerprint,
	receiptSectionHash,
	sealReceipt,
	receiptSealWork
} from './operationReceipts';
import { requireContractWork } from './contractPolicy';
import { contextIdentity, changedContextCompletion } from './contractReviewIdentity';
import { canonicalJson } from '../lib/document/canonical-json';
import { MAX_SELECTED_CONCESSIONS } from '../lib/document/selection-limits';
import { activeJob } from './emailDeliveries';
import { documentBytes } from './storageCapacity';
import { requireNativeReachability } from './nativeStage';

type HeadRow = Omit<Doc<'contractChangeHeads'>, '_id' | '_creationTime'>;
export type AuthorityHead = {
	before: Doc<'contractChangeHeads'> | null;
	row: HeadRow | null;
	oldCurrentId: Id<'contractChanges'> | null;
	oldDecisionId: Id<'contractChangeDecisions'> | null;
	oldRequired: boolean;
	oldStatus: 'pending' | 'approved' | 'rejected';
	nextRequired: boolean;
	nextStatus: 'pending' | 'approved' | 'rejected';
	dirty: boolean;
};
export type AuthoritySnapshot = {
	build: NativeBuild;
	input: AuthorityInput;
	target: Awaited<ReturnType<typeof authorityTarget>>;
	root: Contract['root'];
	actor: ReturnType<typeof changeActorOf>;
	key: string;
	createdAt: number;
	admin: boolean;
	scan: AuthorityHead | null;
};
const authorityAction = makeFunctionReference<'action', NativeOwner, null>(
	'nativeAuthorityAction:construct'
);
const hash = (value: unknown) => receiptChunkFingerprint(canonicalJson(value));
function rowOf(row: Doc<'contractChangeHeads'>): HeadRow {
	const { _id, _creationTime, ...fields } = row;
	return fields;
}
function headOf(head: Awaited<ReturnType<typeof authorityTarget>>['head']): AuthorityHead {
	return {
		before: head?.storedHead ?? null,
		row: head
			? rowOf(
					head.storedHead.currentChangeId === head.head.currentChangeId
						? head.storedHead
						: {
								...head.storedHead,
								currentChangeId: head.head.currentChangeId,
								currentDecisionId: head.head.currentDecisionId,
								pendingAdmissionRevision: head.head.pendingAdmissionRevision
							}
				)
			: null,
		oldCurrentId: head?.current?._id ?? null,
		oldDecisionId: head?.decision?._id ?? null,
		oldRequired: head?.current?.policy === 'required',
		oldStatus: head?.head.status ?? 'approved',
		nextRequired: head?.current?.policy === 'required',
		nextStatus: head?.head.status ?? 'approved',
		dirty: false
	};
}
async function record(ctx: QueryCtx, row: Doc<'operationReceipts'>, order: number) {
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
	if (
		!chunk ||
		chunk.companyId !== row.companyId ||
		chunk.recordCount !== 1 ||
		receiptChunkFingerprint(chunk.data) !== chunk.fingerprint
	)
		throw new Error('Native authority head checkpoint integrity failed.');
	return { chunk, head: JSON.parse(chunk.data) as AuthorityHead };
}
async function put(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	order: number,
	head: AuthorityHead,
	existing?: Doc<'operationReceiptChunks'>
) {
	const data = canonicalJson(head);
	if (getConvexSize(data) > 128 * 1024)
		throw new Error('Native authority head exceeds its bounded envelope.');
	const fields = { data, fingerprint: receiptChunkFingerprint(data) };
	if (existing) await ctx.db.patch('operationReceiptChunks', existing._id, fields);
	else
		await ctx.db.insert('operationReceiptChunks', {
			companyId: row.companyId,
			receiptId: row._id,
			section: 'native-result',
			generation: row.preparation!.native!.generation,
			order,
			nativeKey: `authority:${order}`,
			recordCount: 1,
			...fields
		});
}
function mark(head: AuthorityHead) {
	head.dirty = canonicalJson(head.before ? rowOf(head.before) : null) !== canonicalJson(head.row);
}
function restore(head: AuthorityHead) {
	const row = head.row;
	if (!row) return;
	if (!row.appliedChangeId) head.row = null;
	else
		head.row = {
			...row,
			currentChangeId: row.appliedChangeId,
			currentDecisionId: row.appliedDecisionId,
			pendingAdmissionRevision: undefined,
			...(row.playbook ? { playbook: { ...row.playbook, current: row.playbook.applied } } : {})
		};
	head.nextRequired = Boolean(
		head.row &&
		(head.row.kind === 'buyer-proposal' || head.row.playbook?.current?.policy === 'required')
	);
	head.nextStatus = 'approved';
	mark(head);
}
async function persist(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	native: NonNullable<NonNullable<Doc<'operationReceipts'>['preparation']>['native']>
) {
	await ctx.db.patch('operationReceipts', row._id, {
		preparation: { ...row.preparation!, native, dueAt: Date.now() }
	});
	await ensureDiscussionMaintenance(ctx, row.contractId!);
}

/** Exact native work progresses once per original receipt unit, including the
 * bounded Playbook alternatives whose combined patches cannot fit a mutation. */
export async function advanceAuthority(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	contract: Contract
) {
	const { access } = await authorizePreparedOperation(ctx, row);
	if (!access) throw new Error('Authority operation lost its seller.');
	const input = JSON.parse((await receiptPayload(ctx, row)).inputs) as AuthorityInput;
	if (!(await nativeValidationCurrent(ctx, row, contract))) {
		// Normal command validation determines whether stale source/head work may restart.
		await runAuthority(ctx, access, contract, input, row);
		return;
	}
	const index = await DiscussionIndex.open(ctx, contract.root);
	const target = await authorityTarget(ctx, contract, access, input, index);
	const native = structuredClone(row.preparation!.native!);
	if (!native.build) {
		await admitDiscussionWork(ctx, { reads: 8, queries: 8, writes: 4, bytes: 160 * 1024 });
		native.build = initialNativeBuild(
			contract,
			row.preparation!.sourceDocumentId,
			native.recordsHash
		);
		native.phase = 'constructing';
		await put(ctx, row, 0, headOf(target.head));
		native.build.headCount = 1;
		native.build.changeId = target.change?._id;
	}
	const b = native.build;
	if (native.phase === 'sealed') {
		if (!row.preparation!.proofComplete || !row.preparation!.supportComplete)
			await advanceNativeProof(ctx, row, contract);
		else if (!(await adoptAuthority(ctx, row))) await advanceNativeProof(ctx, row, contract);
		return;
	}
	try {
		if (b.phase === 'initialize') {
			for (let turn = 0; turn < 8; turn++) {
				await admitDiscussionWork(ctx, { reads: 8, queries: 8, writes: 2, bytes: 160 * 1024 });
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
				for (const stored of page.page) {
					if (stored.companyId !== row.companyId)
						throw new Error('Native authority comparison ownership changed.');
					if (stored._id !== target.head?.storedHead._id) {
						const state = playbookStateOf(stored)!;
						const value: AuthorityHead = {
							before: stored,
							row: rowOf(stored),
							oldCurrentId: stored.currentChangeId ?? null,
							oldDecisionId: stored.currentDecisionId ?? null,
							oldRequired: stored.playbook?.current?.policy === 'required',
							oldStatus: state.status,
							nextRequired: stored.playbook?.current?.policy === 'required',
							nextStatus: state.status,
							dirty: false
						};
						await put(ctx, row, b.headCount++, value);
					}
					native.activePlaybookCount++;
					if (native.activePlaybookCount > MAX_SELECTED_CONCESSIONS)
						throw new Error('Playbook selection bound failed.');
				}
				native.playbookCursor = page.continueCursor;
				if (page.isDone) {
					b.phase = 'patch';
					break;
				}
			}
			native.unit++;
		} else if (b.phase === 'seal') {
			for (let turn = 0; turn < 8 && b.cursor < b.headCount; turn++) {
				await admitDiscussionWork(ctx, { reads: 4, queries: 4, writes: 1, bytes: 160 * 1024 });
				const { chunk, head } = await record(ctx, row, b.cursor);
				mark(head);
				if (head.dirty) {
					b.dirtyCount++;
					const kind = head.row?.kind ?? head.before?.kind;
					if (kind === 'playbook') {
						b.playbookSelectionCount +=
							Number(head.row?.activePlaybook ?? false) -
							Number(head.before?.activePlaybook ?? false);
						b.playbookReviewCount += Number(head.nextRequired) - Number(head.oldRequired);
						b.playbookPendingCount +=
							Number(head.nextRequired && head.nextStatus === 'pending') -
							Number(head.oldRequired && head.oldStatus === 'pending');
						b.playbookDeclinedCount +=
							Number(head.nextRequired && head.nextStatus === 'rejected') -
							Number(head.oldRequired && head.oldStatus === 'rejected');
						if (
							hash(head.oldRequired ? [head.oldCurrentId, head.oldDecisionId] : null) !==
							hash(
								head.nextRequired
									? [head.row?.currentChangeId, head.row?.currentDecisionId ?? null]
									: null
							)
						)
							b.contextChanged = true;
					}
				}
				await put(ctx, row, b.cursor, head, chunk);
				b.headsHash = receiptSectionHash(b.headsHash, b.cursor, hash(head), 1);
				b.headsBytes += new TextEncoder().encode(canonicalJson(head)).length;
				b.cursor++;
			}
			if (b.cursor === b.headCount) {
				if (
					b.playbookSelectionCount < 0 ||
					b.playbookSelectionCount > MAX_SELECTED_CONCESSIONS ||
					[b.playbookReviewCount, b.playbookPendingCount, b.playbookDeclinedCount].some(
						(n) => !Number.isSafeInteger(n) || n < 0
					)
				)
					throw new Error('Native authority counters are invalid.');
				const [before, after] = await Promise.all([
					ctx.db.get('contractDocuments', row.preparation!.sourceDocumentId),
					ctx.db.get('contractDocuments', b.documentId)
				]);
				if (!before || !after) throw new Error('Authority document seal disappeared.');
				b.documentChanged = before.fingerprint !== after.fingerprint;
				if (!b.documentChanged) b.documentId = before._id;
				b.identity = hash([
					row.key,
					input,
					native.generation,
					b.headsHash,
					b.changeIds,
					b.decisionIds,
					before.fingerprint,
					after.fingerprint
				]);
				b.phase = 'geometry';
			}
			native.unit++;
		} else if (!(await activeJob(ctx, native.jobId))) {
			native.jobId = await ctx.scheduler.runAfter(0, authorityAction, {
				receiptId: row._id,
				generation: native.generation,
				unit: native.unit
			});
		}
	} catch (error) {
		if (!(error instanceof DiscussionPreparationRequired)) throw error;
		// Completed cursor units persist; no native business state was written.
		native.unit++;
		native.jobId = undefined;
	}
	await persist(ctx, row, native);
}

export const snapshot = internalQuery({
	args: nativeOwnerArgs,
	returns: v.union(v.null(), v.string()),
	handler: async (ctx, args) => {
		const state = await constructionOwned(ctx, args);
		if (!state?.access || !state.native.build) return null;
		const input = JSON.parse((await receiptPayload(ctx, state.row)).inputs) as AuthorityInput;
		const target = await authorityTarget(
			ctx,
			state.contract,
			state.access,
			input,
			await DiscussionIndex.open(ctx, state.contract.root)
		);
		const value: AuthoritySnapshot = {
			build: state.native.build,
			input,
			target,
			root: state.contract.root,
			actor: changeActorOf(state.access),
			key: state.row.key,
			createdAt: state.row._creationTime,
			admin: state.access.membership.role === 'admin',
			scan:
				state.native.build.phase === 'compare' &&
				state.native.build.cursor < state.native.build.headCount
					? (await record(ctx, state.row, state.native.build.cursor)).head
					: null
		};
		return JSON.stringify(value);
	}
});

const checkpointValue = v.union(
	v.object({
		kind: v.literal('constructed'),
		documentId: v.optional(v.id('contractDocuments')),
		changeId: v.optional(v.id('contractChanges')),
		tapeLength: v.number()
	}),
	v.object({ kind: v.literal('compared'), incompatible: v.boolean() })
);
async function staged(
	ctx: QueryCtx,
	state: NonNullable<Awaited<ReturnType<typeof constructionOwned>>>,
	table: 'contractDocuments',
	id: Id<'contractDocuments'>
): Promise<Doc<'contractDocuments'>>;
async function staged(
	ctx: QueryCtx,
	state: NonNullable<Awaited<ReturnType<typeof constructionOwned>>>,
	table: 'contractChanges',
	id: Id<'contractChanges'>
): Promise<Doc<'contractChanges'>>;
async function staged(
	ctx: QueryCtx,
	state: NonNullable<Awaited<ReturnType<typeof constructionOwned>>>,
	table: 'contractDocuments' | 'contractChanges',
	id: Id<'contractDocuments'> | Id<'contractChanges'>
) {
	const row =
		table === 'contractDocuments'
			? await ctx.db.get('contractDocuments', id as Id<'contractDocuments'>)
			: await ctx.db.get('contractChanges', id as Id<'contractChanges'>);
	if (
		!row ||
		row.companyId !== state.row.companyId ||
		row.contractId !== state.contract.root._id ||
		!row.stage ||
		row.stage.receiptId !== state.row._id ||
		row.stage.generation !== state.native.generation ||
		row.stage.unit !== state.native.unit ||
		!row.stage.sealed
	)
		throw new Error('Authority result stage ownership/seal failed.');
	return row;
}
export const checkpoint = internalMutation({
	args: { ...nativeOwnerArgs, value: checkpointValue },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await constructionOwned(ctx, args);
		if (!state?.access || !state.native.build) return null;
		const { row, contract, access } = state,
			native = structuredClone(state.native),
			b = native.build!;
		const input = JSON.parse((await receiptPayload(ctx, row)).inputs) as AuthorityInput;
		const target = await authorityTarget(
			ctx,
			contract,
			access,
			input,
			await DiscussionIndex.open(ctx, contract.root)
		);
		await admitDiscussionWork(ctx, { reads: 16, queries: 16, writes: 6, bytes: 320 * 1024 });
		if (args.value.kind === 'constructed') {
			if (b.phase !== 'patch') throw new Error('Authority construction cursor changed.');
			const value = args.value,
				stored = await record(ctx, row, 0),
				head = stored.head;
			b.tapeLength = value.tapeLength;
			if (value.documentId) {
				await staged(ctx, state, 'contractDocuments', value.documentId);
				b.documentId = value.documentId;
			}
			const decision = async (
				changeId: Id<'contractChanges'>,
				action: 'approve' | 'decline' | 'undo',
				previousDecisionId?: Id<'contractChangeDecisions'>
			) => {
				const id = await ctx.db.insert('contractChangeDecisions', {
					companyId: row.companyId,
					contractId: contract.root._id,
					changeId,
					actor: changeActorOf(access),
					operationId: row.key,
					previousDecisionId,
					action,
					status: action === 'approve' ? 'approved' : 'rejected',
					decidedAt: row._creationTime,
					stage: {
						receiptId: row._id,
						generation: native.generation,
						unit: native.unit,
						slot: 'decision',
						written: 1,
						sealed: true
					}
				});
				b.decisionIds.push(id);
				return id;
			};
			if (input.kind === 'proposal-support' && 'changeId' in input.args) restore(head);
			else if (input.kind === 'proposal-support' && value.changeId) {
				const change = await staged(ctx, state, 'contractChanges', value.changeId);
				if (
					change.kind !== 'buyer-proposal' ||
					change.key !== input.args.threadId ||
					change.patchKey !== row.key ||
					change.operationId !== row.key ||
					change.actor.profileId !== access.profile._id ||
					change.source.rootMessageId !== input.args.rootMessageId ||
					change.source.rootRevision !== input.args.expectedRootRevision ||
					change.source.documentId !== contract.root.documentId ||
					change.source.documentRevision !== contract.root.documentRevision ||
					change.predecessorId !== target.head?.applied?._id
				)
					throw new Error('Authority proposal result changed its exact source.');
				b.changeIds.push(change._id);
				const approve = access.membership.role === 'admin';
				const decisionId = approve ? await decision(change._id, 'approve') : undefined;
				head.row = {
					companyId: row.companyId,
					contractId: contract.root._id,
					kind: 'buyer-proposal',
					key: input.args.threadId,
					activePlaybook: false,
					currentChangeId: change._id,
					currentDecisionId: decisionId,
					appliedChangeId: approve ? change._id : target.head?.applied?._id,
					appliedDecisionId: approve ? decisionId : target.head?.appliedDecision?._id,
					pendingAdmissionRevision: approve ? undefined : contract.root.stateRevision + 1
				};
				head.nextRequired = true;
				head.nextStatus = approve ? 'approved' : 'pending';
				mark(head);
			} else if (input.kind === 'change-decision') {
				const command = input.args,
					change = target.change!;
				if (!head.row) throw new Error('Authority decision lost its head.');
				const noOp =
					(command.action === 'approve' && head.oldStatus === 'approved') ||
					(command.action === 'decline' && head.oldStatus === 'rejected');
				if (!noOp) {
					const id = await decision(change._id, command.action, head.row.currentDecisionId);
					if (command.action === 'undo') {
						const previous = change.predecessorId
							? await readChangeRow(ctx, change.predecessorId, contract)
							: null;
						let priorDecision: Doc<'contractChangeDecisions'> | null = null;
						if (previous?.policy === 'required') {
							priorDecision = await ctx.db
								.query('contractChangeDecisions')
								.withIndex('by_changeId_and_decidedAt', (q) => q.eq('changeId', previous._id))
								.order('desc')
								.first();
							if (!priorDecision || priorDecision.status !== 'approved')
								throw new ConvexError('Previous wording needs renewed authorization.');
							await effectiveDecision(ctx, contract, previous._id, priorDecision._id);
						}
						head.row = previous
							? {
									...head.row,
									currentChangeId: previous._id,
									appliedChangeId: previous._id,
									currentDecisionId: priorDecision?._id,
									appliedDecisionId: priorDecision?._id,
									pendingAdmissionRevision: undefined
								}
							: null;
						head.nextRequired = previous?.policy === 'required';
						head.nextStatus = 'approved';
					} else {
						head.row.currentDecisionId = id;
						head.row.pendingAdmissionRevision = undefined;
						head.nextStatus = command.action === 'approve' ? 'approved' : 'rejected';
						if (command.action === 'approve') {
							head.row.appliedChangeId = head.row.currentChangeId;
							head.row.appliedDecisionId = id;
							if (head.row.playbook) head.row.playbook.applied = head.row.playbook.current;
							head.row.activePlaybook =
								head.row.kind === 'playbook' &&
								Boolean(
									head.row.playbook?.current?.optionId !== null && head.row.playbook?.current
								);
						}
					}
					mark(head);
				}
			} else if (value.changeId) throw new Error('Unexpected authority patch result.');
			await put(ctx, row, 0, head, stored.chunk);
			b.phase = value.documentId ? 'compare' : 'seal';
			b.cursor = value.documentId ? 1 : 0;
		} else {
			if (b.phase !== 'compare' || b.cursor < 1 || b.cursor >= b.headCount)
				throw new Error('Authority comparison cursor changed.');
			const stored = await record(ctx, row, b.cursor);
			if (args.value.incompatible) {
				restore(stored.head);
				await put(ctx, row, b.cursor, stored.head, stored.chunk);
			}
			b.cursor++;
			if (b.cursor === b.headCount) {
				b.phase = 'seal';
				b.cursor = 0;
			}
		}
		if (b.phase === 'compare' && b.cursor === b.headCount) {
			b.phase = 'seal';
			b.cursor = 0;
		}
		native.unit++;
		native.jobId = undefined;
		await persist(ctx, row, native);
		return null;
	}
});

/** The final transaction reads only compact sealed heads and direct source metadata,
 * prepares its exact tree edits, and publishes business state and original result. */
export async function adoptAuthority(ctx: MutationCtx, row: Doc<'operationReceipts'>) {
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
		throw new Error('Authority result has no complete adoption seal.');
	const index = await DiscussionIndex.open(ctx, contract.root);
	if (
		p.indexGeneration !== index.indexGeneration ||
		p.supportGeneration !== index.supportIndexGeneration ||
		p.storageGeneration !== index.nativeStorageGeneration ||
		p.requestId !== (index.supportSummary.request?.id ?? null) ||
		p.requestCutoff !== (index.supportSummary.request?.cutoff ?? null)
	)
		return false;
	const payload = await receiptPayload(ctx, row),
		input = JSON.parse(payload.inputs) as AuthorityInput;
	const target = await authorityTarget(ctx, contract, access, input, index);
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
		.take(MAX_SELECTED_CONCESSIONS + 2);
	if (chunks.length !== b.headCount || chunks.length > MAX_SELECTED_CONCESSIONS + 1)
		throw new Error('Authority head seal count changed.');
	let digest = native.recordsHash,
		bytes = 0;
	const heads = chunks.map((chunk, i) => {
		if (
			chunk.order !== i ||
			chunk.companyId !== row.companyId ||
			chunk.recordCount !== 1 ||
			receiptChunkFingerprint(chunk.data) !== chunk.fingerprint
		)
			throw new Error('Authority head seal order/integrity failed.');
		const head = JSON.parse(chunk.data) as AuthorityHead;
		digest = receiptSectionHash(digest, i, chunk.fingerprint, 1);
		bytes += new TextEncoder().encode(chunk.data).length;
		return head;
	});
	if (
		digest !== b.headsHash ||
		bytes !== b.headsBytes ||
		heads.filter((h) => h.dirty).length !== b.dirtyCount
	)
		throw new Error('Authority head result seal changed.');
	const document = await ctx.db.get('contractDocuments', b.documentId);
	if (
		!document ||
		document.companyId !== row.companyId ||
		document.contractId !== contract.root._id
	)
		throw new Error('Authority document ownership changed.');
	if (document.stage?.receiptId === row._id) {
		if (document.stage.generation !== native.generation || !document.stage.sealed)
			throw new Error('Authority document stage changed.');
	} else await requireNativeReachability(ctx, 'contractDocuments', document._id, document);
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
	const head = heads[0];
	const nextCurrent = head.row?.currentChangeId
		? await ctx.db.get('contractChanges', head.row.currentChangeId)
		: null;
	const nextApplied = head.row?.appliedChangeId
		? head.row.appliedChangeId === nextCurrent?._id
			? nextCurrent
			: await ctx.db.get('contractChanges', head.row.appliedChangeId)
		: null;
	for (const change of [nextCurrent, nextApplied])
		if (
			change &&
			(change.companyId !== row.companyId ||
				change.contractId !== contract.root._id ||
				(change.stage &&
					(change.stage.receiptId !== row._id ||
						change.stage.generation !== native.generation ||
						!change.stage.sealed)))
		)
			throw new Error('Authority immutable target seal changed.');
	const lostSupports =
		live && p.supportCursor.counts.supportCount < index.supportSummary.supportCount;
	if (live) index.installSupportCounts(p.supportCursor.counts);
	let claim: Awaited<ReturnType<typeof prepareProposalClaim>> | undefined;
	if (head.dirty && input.kind === 'proposal-support') {
		const source = target.source!,
			interval = await index.interval(source.thread);
		if (!interval) throw new ConvexError('This proposal is unavailable.');
		claim = await prepareProposalClaim(ctx, index, source.thread, interval, b.tapeLength!);
	} else if (
		head.dirty &&
		input.kind === 'change-decision' &&
		target.change?.kind === 'buyer-proposal' &&
		target.head?.applied?._id !== target.change._id
	) {
		const thread = await effectiveBuyerSource(ctx, index, target.change);
		if (!thread) throw new ConvexError('This proposal changed. Review its current wording.');
		claim = await prepareProposalClaim(ctx, index, thread, null, b.tapeLength!);
	}
	const buyer = (head.row?.kind ?? head.before?.kind) === 'buyer-proposal';
	if (buyer && head.dirty)
		await prepareBuyerHeadEffects(
			ctx,
			index,
			[
				{
					old: target.head ?? null,
					nextCurrent,
					nextApplied,
					floating: Boolean(nextCurrent && nextCurrent._id !== nextApplied?._id),
					decisionStatus: head.nextStatus === 'pending' ? null : head.nextStatus,
					currentId: () => nextCurrent?._id ?? null,
					decisionId: () => head.row?.currentDecisionId ?? null
				}
			],
			b.tapeLength!,
			contract.root.stateRevision + 1,
			live ? p.map : undefined
		);
	const buyerChanged =
		lostSupports ||
		(buyer &&
			hash(head.oldRequired ? [head.oldCurrentId, head.oldDecisionId] : null) !==
				hash(
					head.nextRequired
						? [head.row?.currentChangeId, head.row?.currentDecisionId ?? null]
						: null
				));
	const rootFields = {
		documentId: b.documentId,
		documentRevision: contract.root.documentRevision + Number(b.documentChanged),
		stateRevision: contract.root.stateRevision + Number(b.dirtyCount > 0),
		savedAt: b.dirtyCount ? Date.now() : contract.root.savedAt,
		playbookSelectionCount: b.playbookSelectionCount,
		playbookReviewCount: b.playbookReviewCount,
		playbookPendingCount: b.playbookPendingCount,
		playbookDeclinedCount: b.playbookDeclinedCount,
		...(b.dirtyCount
			? { lastOperation: { id: row.operationId!, callerId: access.profile._id } }
			: {}),
		...(b.contextChanged
			? (() => {
					const identity = contextIdentity([
						contract.root.playbookReviewIdentity,
						row.key,
						b.identity
					]);
					return {
						playbookReviewIdentity: identity,
						playbookCompletion: changedContextCompletion(
							identity,
							b.playbookReviewCount,
							b.playbookPendingCount,
							access
						)
					};
				})()
			: {}),
		...(buyerChanged
			? (() => {
					const identity = contextIdentity([
						contract.root.buyerLinkReviewIdentity,
						row.key,
						b.identity,
						index.supportSummary.supportCount
					]);
					return {
						buyerLinkReviewIdentity: identity,
						buyerLinkCompletion: changedContextCompletion(
							identity,
							index.supportSummary.reviewCount,
							index.supportSummary.pendingCount,
							access
						)
					};
				})()
			: {})
	};
	const buyerCurrent = await prepareBuyerCurrentView(
		ctx,
		contract.root,
		{ ...contract.root, ...rootFields },
		document.fingerprint
	);
	const directory = await ctx.db
		.query('contractDirectory')
		.withIndex('by_contractId', (q) => q.eq('contractId', contract.root._id))
		.unique();
	if (!directory) throw new Error('Authority adoption lost its contract directory.');
	const activityRow = await prepareAuthorityActivity(
		ctx,
		contract,
		access,
		input,
		target,
		row.key,
		head.dirty
	);
	const nativeResult = {
		generation: native.generation,
		identity: b.identity,
		documentId: b.documentId,
		changeIds: b.changeIds,
		decisionIds: b.decisionIds
	};
	const result = JSON.stringify({ status: 'complete', operationId: row.operationId });
	const seal = await receiptSealWork(ctx, { ...row, nativeResult }, payload.inputs, result);
	const trees = await index.prepareFlush(
		live ? p.witnessThreadId : (index.control?.witnessThreadId ?? null),
		live
	);
	const writeBytes =
		heads.filter((h) => h.dirty).reduce((n, h) => n + (h.row ? documentBytes(h.row) : 128), 0) +
		documentBytes({ ...contract.root, ...rootFields }) +
		documentBytes({
			...directory,
			savedAt: rootFields.savedAt,
			...(live ? { hasUnreadComment: Boolean(p.witnessThreadId) } : {})
		}) +
		trees.bytes +
		(activityRow ? documentBytes({ ...activityRow, _id: 'x'.repeat(32), _creationTime: 0 }) : 0) +
		(claim?.work.bytes ?? 0) +
		seal.bytes +
		documentBytes({ ...row, nativeResult }) +
		32 * 1024;
	const metrics = await ctx.meta.getTransactionMetrics();
	if (
		metrics.documentsWritten.remaining <
			b.dirtyCount +
				trees.documents +
				(claim?.work.documents ?? 0) +
				seal.writes +
				Number(Boolean(activityRow)) +
				16 +
				(buyerCurrent.work.documents ?? 0) ||
		metrics.bytesWritten.remaining < writeBytes + (buyerCurrent.work.bytes ?? 0) + 1_000_000 ||
		metrics.databaseQueries.remaining < seal.reads + (buyerCurrent.work.queries ?? 0) + 64 ||
		metrics.documentsRead.remaining < seal.reads + 64 ||
		metrics.bytesRead.remaining < seal.readBytes + 1_000_000 ||
		metrics.functionsScheduled.remaining < 2 ||
		metrics.scheduledFunctionArgsBytes.remaining < 8192
	)
		throw new DiscussionPreparationRequired('capacity');
	for (const value of heads)
		if (value.dirty) {
			if (value.row) {
				if (value.before) await ctx.db.replace('contractChangeHeads', value.before._id, value.row);
				else await ctx.db.insert('contractChangeHeads', value.row);
			} else if (value.before) await ctx.db.delete('contractChangeHeads', value.before._id);
		}
	await claim?.commit();
	if (live) {
		await index.recordTransition(ctx, p.map!);
		await index.flush(
			ctx,
			p.witnessThreadId,
			await scheduleDiscussionMaintenance(ctx, index),
			false
		);
	} else {
		if (buyer) await index.flush(ctx, index.control?.witnessThreadId ?? null, undefined, false);
	}
	await patchContract(ctx, contract, rootFields, {
		...(live ? { hasUnreadComment: Boolean(p.witnessThreadId) } : {}),
		directoryRow: directory,
		buyerCurrent
	});
	if (activityRow) await ctx.db.insert('hubspotEvents', activityRow);
	await ctx.db.patch('operationReceipts', row._id, { nativeResult });
	await sealReceipt(ctx, row, payload.inputs, { state: 'complete', result });
	return true;
}
