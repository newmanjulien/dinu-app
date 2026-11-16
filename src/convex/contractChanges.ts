import { prepareBuyerCurrentView } from './buyerCurrent';
import { ConvexError, getConvexSize, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { CompanyAccess } from './auth';
import { patchContract, type Contract, type CurrentContractRoot } from './contractState';
import type { ContractChange } from '../lib/playbook/model';
import { reviewGroupKey, type ChangeActor, type ChangeKind, type DecisionCommand } from '../lib/contract/changes';
import type { PlaybookState } from '../lib/contract/changes';
import {
	assertChangeHead,
	assertHeadChange,
	createChangeHead,
	restoreAppliedHead,
	currentDecisionId,
	appliedDecisionId,
	pendingAdmissionRevision,
	playbookProjection
} from './contractChangeHeads';
import { canonicalJson } from '../lib/document/canonical-json';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
	applyDocumentChange,
	DocumentChangeConflict,
	prepareDocumentChange,
	prepareDocumentTransition,
	reverseDocumentChange,
	type ContractDocument,
	type DocumentChange
} from '../lib/document/contract-document';
import {
	assertContractDocumentRenderCapacity,
	readContractDocument,
	prepareContractDocument,
	commitContractDocument
} from './contractDocuments';
import { documentBytes } from './storageCapacity';
import type {
	storedContractChange,
	storedContractChangeDecision
} from './contractChangeValidators';
import { DiscussionIndex } from './discussionIndex';
import { effectiveBuyerSource } from './buyerSupportEligibility';
import { MAX_SELECTED_CONCESSIONS } from '../lib/document/selection-limits';
import { contextIdentity, changedContextCompletion } from './contractReviewIdentity';
import { DiscussionPreparationRequired, admitDiscussionWork } from './discussionMaps';
import { requireNativeReachability } from './nativeStage';

type ContractOwner = { root: Pick<Contract['root'], '_id' | 'companyId'> };
export const MAX_APPROVED_CHANGE_CHAIN = 256;
const headKey = (kind: ChangeKind, key: string) => JSON.stringify([kind, key]);
export const changeActorOf = (access: CompanyAccess): ChangeActor => ({
	profileId: access.profile._id,
	name: access.profile.name,
	email: access.profile.email
});
export type CurrentChangeHead = Doc<'contractChangeHeads'> & {
	status: 'pending' | 'approved' | 'rejected';
};
export async function readChangeRow(
	ctx: QueryCtx,
	id: Id<'contractChanges'>,
	contract: ContractOwner
) {
	const row = await ctx.db.get('contractChanges', id);
	if (!row || row.companyId !== contract.root.companyId || row.contractId !== contract.root._id)
		throw new ConvexError('This contract change is unavailable.');
	await requireNativeReachability(ctx, 'contractChanges', id, row);
	return row;
}
export async function effectiveDecision(
	ctx: QueryCtx,
	contract: ContractOwner,
	changeId: Id<'contractChanges'>,
	decisionId: Id<'contractChangeDecisions'>
) {
	const row = await ctx.db.get('contractChangeDecisions', decisionId);
	if (
		!row ||
		row.contractId !== contract.root._id ||
		row.companyId !== contract.root.companyId ||
		row.changeId !== changeId
	)
		throw new Error('Invalid effective contract decision.');
	await requireNativeReachability(ctx, 'contractChangeDecisions', decisionId, row);
	return row;
}
export async function hydrateHead(
	ctx: QueryCtx,
	contract: ContractOwner,
	row: Doc<'contractChangeHeads'>,
	index?: DiscussionIndex
) {
	if (row.companyId !== contract.root.companyId || row.contractId !== contract.root._id)
		throw new Error('Invalid contract change head ownership.');
	assertChangeHead(row);
	let current = row.current ? await readChangeRow(ctx, row.current.changeId, contract) : null;
	const applied = row.applied
		? row.applied.changeId === current?._id
			? current
			: await readChangeRow(ctx, row.applied.changeId, contract)
		: null;
	if (current) assertHeadChange(row, 'current', current);
	if (applied) assertHeadChange(row, 'applied', applied);
	let decision =
		current && currentDecisionId(row.current)
			? await effectiveDecision(ctx, contract, current._id, currentDecisionId(row.current)!)
			: null;
	const appliedDecision =
		applied && appliedDecisionId(row.applied)
			? appliedDecisionId(row.applied) === currentDecisionId(row.current) &&
				applied._id === current?._id
				? decision
				: await effectiveDecision(ctx, contract, applied._id, appliedDecisionId(row.applied)!)
			: null;
	if (applied?.policy === 'required' && appliedDecision?.status !== 'approved')
		throw new Error('Applied wording has no exact approval.');
	if (
		current &&
		(current.policy === 'none' || decision?.status === 'approved') &&
		current._id !== applied?._id
	)
		throw new Error('Approved current wording is not applied.');
	if (
		current &&
		current._id === applied?._id &&
		current.policy === 'required' &&
		decision?.status !== 'approved'
	)
		throw new Error('Applied current wording has no exact approval.');
	const storedHead = row;
	const storedCurrent = current;
	if (current?.kind === 'buyer-link' && current._id !== applied?._id) {
		if (!index) {
			const root = await ctx.db.get('savedContracts', contract.root._id);
			if (!root || root.companyId !== contract.root.companyId)
				throw new Error('Buyer support has no owned contract.');
			index = await DiscussionIndex.open(ctx, root);
		}
		const source = await effectiveBuyerSource(ctx, index, current);
		if (!source) {
			current = applied;
			decision = appliedDecision;
			const restored = restoreAppliedHead(row);
			row = restored ? { ...row, ...restored } : { ...row, current: null };
		} else {
			const support = await index.supportEntry(source);
			if (
				!support ||
				support.changeId !== current._id ||
				support.threadId !== source._id ||
				support.withApplied !== Boolean(applied) ||
				support.decisionId !== currentDecisionId(row.current) ||
				support.rootMessageId !== current.source.rootMessageId ||
				support.rootRevision !== current.source.rootRevision ||
				(support.status === 'pending' &&
					support.admissionRevision !== pendingAdmissionRevision(row.current)) ||
				(support.status === 'pending' ? decision !== null : decision?.status !== 'rejected')
			)
				throw new Error('An effective buyer support has no exact aggregate entry.');
		}
	}
	const status =
		!current || current.policy === 'none' ? ('approved' as const) : (decision?.status ?? 'pending');
	return {
		storedHead,
		storedCurrent,
		head: { ...row, status } satisfies CurrentChangeHead,
		current,
		applied,
		decision,
		appliedDecision
	};
}
export async function changeHead(
	ctx: QueryCtx,
	contract: ContractOwner,
	kind: ChangeKind,
	key: string,
	index?: DiscussionIndex
) {
	const row = await ctx.db
		.query('contractChangeHeads')
		.withIndex('by_contractId_and_kind_and_key', (q) =>
			q.eq('contractId', contract.root._id).eq('kind', kind).eq('key', key)
		)
		.unique();
	return row ? hydrateHead(ctx, contract, row, index) : null;
}
/** Exact bounded projection shares the same bundle checks as hydrated reads. */
export const playbookStateOf = playbookProjection;
export async function readChange(
	ctx: QueryCtx,
	id: Id<'contractChanges'>,
	contract: ContractOwner,
	options: { deferOnCapacity?: boolean; row?: Doc<'contractChanges'> } = {}
) {
	const row = options.row ?? (await readChangeRow(ctx, id, contract));
	if (
		row._id !== id ||
		row.companyId !== contract.root.companyId ||
		row.contractId !== contract.root._id
	)
		throw new Error('Invalid immutable patch owner.');
	if (options.row) await requireNativeReachability(ctx, 'contractChanges', id, row);
	if (!Number.isSafeInteger(row.chunks) || row.chunks < 1 || row.chunks > 64)
		throw new Error('Contract change payload is incomplete.');
	const budget = await ctx.meta.getTransactionMetrics();
	if (
		budget.bytesRead.remaining <
			row.dataBytes + row.chunks * 1024 + (options.deferOnCapacity ? 1_000_000 : 32_768) ||
		budget.databaseQueries.remaining < row.chunks + (options.deferOnCapacity ? 48 : 0) ||
		budget.documentsRead.remaining < row.chunks + (options.deferOnCapacity ? 48 : 0)
	) {
		if (options.deferOnCapacity) throw new DiscussionPreparationRequired('capacity');
		throw new ConvexError('The combined contract changes exceed supported read capacity.');
	}
	const parts: Doc<'contractChangeContents'>[] = [];
	for (let order = 0; order < row.chunks; order++) {
		const metrics = await ctx.meta.getTransactionMetrics();
		if (
			metrics.bytesRead.remaining < (options.deferOnCapacity ? 1_000_000 : 500_000) ||
			metrics.databaseQueries.remaining < (options.deferOnCapacity ? 49 : 2)
		) {
			if (options.deferOnCapacity) throw new DiscussionPreparationRequired('capacity');
			throw new ConvexError('The combined contract changes exceed supported read capacity.');
		}
		const part = await ctx.db
			.query('contractChangeContents')
			.withIndex('by_changeId_and_order', (q) => q.eq('changeId', id).eq('order', order))
			.unique();
		if (!part || part.companyId !== row.companyId || part.contractId !== row.contractId)
			throw new Error('Contract change payload is incomplete.');
		parts.push(part);
	}
	const patch = JSON.parse(parts.map((part) => part.data).join('')) as DocumentChange;
	if (patch.id !== row.patchKey) throw new Error('Invalid contract patch identity.');
	return { row, patch };
}
export async function approvedChain(
	ctx: QueryCtx,
	contract: ContractOwner,
	id?: Id<'contractChanges'>
) {
	const patches: DocumentChange[] = [],
		seen = new Set<string>();
	while (id) {
		if (seen.has(id) || seen.size >= MAX_APPROVED_CHANGE_CHAIN)
			throw new ConvexError('This widget has too many wording revisions.');
		seen.add(id);
		const change = await readChange(ctx, id, contract);
		patches.push(change.patch);
		id = change.row.predecessorId;
	}
	return patches;
}
export async function approvedDocument(
	ctx: QueryCtx,
	contract: ContractOwner & { root: Pick<Contract['root'], '_id' | 'companyId' | 'documentId'> },
	options: { deferOnCapacity?: boolean } = {}
) {
	return readContractDocument(
		ctx,
		contract.root.documentId,
		{
			companyId: contract.root.companyId,
			contractId: contract.root._id
		},
		options
	);
}

type ChangeRow = Infer<typeof storedContractChange>;
type DecisionRow = Infer<typeof storedContractChangeDecision>;
type SessionChange = {
	id?: Id<'contractChanges'>;
	row: ChangeRow;
	patch?: DocumentChange;
	predecessor?: SessionChange;
	parts?: string[];
};
type SessionDecision = {
	id?: Id<'contractChangeDecisions'>;
	row: Omit<DecisionRow, 'changeId'>;
	change: SessionChange;
};
export type SessionHead = {
	stored?: Doc<'contractChangeHeads'>;
	initial?: Awaited<ReturnType<typeof hydrateHead>>;
	kind: ChangeKind;
	key: string;
	current?: SessionChange;
	applied?: SessionChange;
	currentDecision?: SessionDecision;
	appliedDecision?: SessionDecision;
	dirty: boolean;
};
export type TransitionPlan = {
	before: ContractDocument | null;
	after: ContractDocument | null;
	sourceTapeLength?: number;
	documentChanged: boolean;
	// Exact old IDs let request snapshots be intersected without erasing unrelated entries.
	canceledChangeIds: Id<'contractChanges'>[];
	changedContexts: ('playbook' | 'buyer-link')[];
	// Stable geometry/command identity: generated row IDs never enter this value.
	identity: string;
	// Command/Playbook bounded, never a contract-wide buyer cancellation list.
	heads: readonly SessionHead[];
	buyerReviewCount?: number;
	supportCommitment?: import('./discussionSupportTree').SupportCounts;
};
export type TransitionWork = {
	documents?: number;
	bytes?: number;
	queries?: number;
	readDocuments?: number;
	readBytes?: number;
	functionsScheduled?: number;
	scheduledFunctionArgsBytes?: number;
};
export async function admitTransition(ctx: MutationCtx, work: TransitionWork) {
	const metrics = await ctx.meta.getTransactionMetrics();
	if (
		metrics.documentsWritten.remaining < (work.documents ?? 0) + 48 ||
		metrics.bytesWritten.remaining < (work.bytes ?? 0) + 1_000_000 ||
		metrics.databaseQueries.remaining < (work.queries ?? 0) + 48 ||
		metrics.documentsRead.remaining < (work.readDocuments ?? 0) + 48 ||
		metrics.bytesRead.remaining < (work.readBytes ?? 0) + 1_000_000 ||
		metrics.functionsScheduled.remaining < (work.functionsScheduled ?? 0) + 1 ||
		metrics.scheduledFunctionArgsBytes.remaining < (work.scheduledFunctionArgsBytes ?? 0) + 4096
	)
		throw new DiscussionPreparationRequired('capacity');
}
export type TransitionHooks = {
	/** Geometry-dependent support withdrawal must run before the final plan/dirty heads freeze. */
	beforePlan?: (session: {
		before: ContractDocument;
		after: ContractDocument;
		pendingBuyerProposals: {
			changeId: Id<'contractChanges'> | null;
			key: string;
			source: Extract<ChangeRow, { kind: 'buyer-link' }>['source'];
		}[];
		withdraw: (key: string, expectedChangeId: Id<'contractChanges'> | null) => Promise<void>;
	}) => Promise<void>;
	/** Runs before any business writes. P2 prepares exact unread/maps or retains the original receipt pending here. */
	beforeCommit?: (plan: TransitionPlan) => Promise<{ hasUnreadComment?: boolean } | void>;
	/** Prepare all hook-owned writes/reads (including P3 pointers) before native writes. */
	reserve?: (plan: TransitionPlan) => Promise<TransitionWork>;
	/** Runs in the same transaction after native IDs exist, before the final root write. */
	afterChanges?: (plan: TransitionPlan) => Promise<void>;
	/** P3 updates the existing buyer-link current-view pointer only for buyer-visible changes. */
	afterCommit?: (plan: TransitionPlan, contract: Contract) => Promise<void>;
};
/** Plans all native effects first; commit writes one final manifest and the root once. */
export async function changeSession(
	ctx: MutationCtx,
	contract: Contract,
	mode?: { sourceOnly: { tapeLength: number } }
) {
	// Exact floating-source withdrawal changes no document. Keep its session native
	// without reading a potentially oversized immutable document just to restore IDs.
	let before!: ContractDocument, document!: ContractDocument;
	if (!mode?.sourceOnly) {
		before = await approvedDocument(ctx, contract, { deferOnCapacity: true });
		document = before;
	}
	let committed = false;
	const heads = new Map<string, SessionHead>(),
		changes = new Map<string, SessionChange>();
	const pendingChanges: SessionChange[] = [],
		pendingDecisions: SessionDecision[] = [];
	const canceled = new Set<Id<'contractChanges'>>();
	const placeholder = 'x'.repeat(32);
	const projectedIds = new Map<object, string>();
	const plannedId = <T extends string>(value: { id?: T } | undefined): T | undefined => {
		if (!value) return undefined;
		if (value.id) return value.id;
		let id = projectedIds.get(value);
		if (!id) {
			id = `x${projectedIds.size.toString(36).padStart(31, '0')}`;
			projectedIds.set(value, id);
		}
		return id as T;
	};
	const sessionHeadRow = (value: SessionHead) =>
		createChangeHead({
			companyId: contract.root.companyId,
			contractId: contract.root._id,
			kind: value.kind,
			key: value.key,
			current: value.current
				? {
						changeId: plannedId(value.current)!,
						change: value.current.row,
						decisionId: plannedId(value.currentDecision),
						admissionRevision: contract.root.stateRevision + 1
					}
				: null,
			applied: value.applied
				? {
						changeId: plannedId(value.applied)!,
						change: value.applied.row,
						decisionId: plannedId(value.appliedDecision)
					}
				: null
		});
	function loaded(row: Doc<'contractChanges'>): SessionChange {
		let change = changes.get(row._id);
		if (!change) {
			change = { id: row._id, row };
			changes.set(row._id, change);
		}
		return change;
	}
	async function load(id: Id<'contractChanges'>): Promise<SessionChange> {
		return changes.get(id) ?? loaded(await readChangeRow(ctx, id, contract));
	}
	async function patchFor(change: SessionChange): Promise<DocumentChange> {
		if (!change.patch) {
			if (!change.id) throw new Error('Missing immutable patch.');
			change.patch = (
				await readChange(ctx, change.id, contract, {
					deferOnCapacity: true,
					row: change.row as Doc<'contractChanges'>
				})
			).patch;
		}
		return change.patch;
	}
	function fromDecision(
		row: Doc<'contractChangeDecisions'> | null,
		change: SessionChange | undefined
	) {
		if (!row) return undefined;
		if (!change?.id || change.id !== row.changeId)
			throw new Error('Missing exact decision target.');
		const { changeId, _id, _creationTime, ...fields } = row;
		return { id: _id, row: fields, change } satisfies SessionDecision;
	}
	async function decision(
		id: Id<'contractChangeDecisions'> | undefined,
		change: SessionChange | undefined
	) {
		if (!id) return undefined;
		if (!change?.id) throw new Error('Missing exact decision target.');
		return fromDecision(await effectiveDecision(ctx, contract, change.id, id), change);
	}
	async function head(kind: ChangeKind, key: string): Promise<SessionHead> {
		const identity = headKey(kind, key);
		let value = heads.get(identity);
		if (!value) {
			await admitDiscussionWork(ctx, { reads: 8, queries: 8 });
			const item = await changeHead(ctx, contract, kind, key);
			const current = item?.current ? loaded(item.current) : undefined;
			const applied = item?.applied ? loaded(item.applied) : undefined;
			value = {
				stored: item?.storedHead,
				initial: item ?? undefined,
				kind,
				key,
				current,
				applied,
				currentDecision: item ? fromDecision(item.decision, current) : undefined,
				appliedDecision: item ? fromDecision(item.appliedDecision, applied) : undefined,
				dirty: false
			};
			heads.set(identity, value);
		}
		return value;
	}
	let playbookLoaded = false;
	async function loadPlaybook() {
		if (playbookLoaded) return;
		let count = 0;
		for await (const row of ctx.db
			.query('contractChangeHeads')
			.withIndex('by_contractId_and_kind_and_activePlaybook', (q) =>
				q.eq('contractId', contract.root._id).eq('kind', 'playbook').eq('activePlaybook', true)
			)) {
			await admitDiscussionWork(ctx, { reads: 8, queries: 8 });
			if (++count > MAX_SELECTED_CONCESSIONS) throw new Error('Playbook selection bound failed.');
			await head('playbook', row.key);
		}
		playbookLoaded = true;
	}

	const status = (value: SessionHead): 'pending' | 'approved' | 'rejected' =>
		!value.current || value.current.row.policy === 'none'
			? ('approved' as const)
			: (value.currentDecision?.row.status ?? 'pending');
	function touch(value: SessionHead) {
		value.dirty = true;
	}
	function restore(value: SessionHead) {
		if (value.current?.id && value.current !== value.applied) canceled.add(value.current.id);
		value.current = value.applied;
		value.currentDecision = value.appliedDecision;
		touch(value);
	}
	async function ancestors(value: SessionChange | undefined) {
		const result: SessionChange[] = [],
			seen = new Set<string>();
		while (value) {
			if (seen.has(value.row.patchKey) || result.length >= MAX_APPROVED_CHANGE_CHAIN)
				throw new ConvexError('This widget has too many wording revisions.');
			seen.add(value.row.patchKey);
			result.push(value);
			value =
				value.predecessor ??
				(value.row.predecessorId ? await load(value.row.predecessorId) : undefined);
		}
		return result;
	}
	async function undoEligibility(value: SessionHead) {
		if (!value.applied || value.current !== value.applied)
			return { allowed: false, reason: 'This change is no longer the applied head.' };
		const patch = await patchFor(value.applied);
		try {
			reverseDocumentChange(document, patch);
			return { allowed: true, reason: null };
		} catch (error) {
			if (!(error instanceof DocumentChangeConflict)) throw error;
			return {
				allowed: false,
				reason:
					error instanceof Error
						? error.message
						: 'A later approved change depends on this wording.'
			};
		}
	}
	async function cancelIncompatible(except: SessionHead) {
		await loadPlaybook();
		for (const value of heads.values()) {
			if (
				value === except ||
				value.kind !== 'playbook' ||
				!value.current ||
				value.current === value.applied ||
				status(value) === 'approved'
			)
				continue;
			const patch = await patchFor(value.current);
			try {
				applyDocumentChange(document, patch);
			} catch (error) {
				if (!(error instanceof DocumentChangeConflict)) throw error;
				restore(value);
			}
		}
	}
	function record(
		value: SessionHead,
		access: CompanyAccess,
		operationId: string,
		action: DecisionCommand['action']
	) {
		if (!value.current) throw new Error('Missing decision target.');
		const entry: SessionDecision = {
			change: value.current,
			row: {
				companyId: contract.root.companyId,
				contractId: contract.root._id,
				actor: changeActorOf(access),
				operationId,
				previousDecisionId: value.currentDecision?.id,
				action,
				status: action === 'approve' ? 'approved' : 'rejected',
				decidedAt: Date.now()
			}
		};
		pendingDecisions.push(entry);
		value.currentDecision = entry;
		if (action === 'approve') value.appliedDecision = entry;
	}
	async function stage(args: {
		source:
			| { kind: 'playbook'; value: Extract<ChangeRow, { kind: 'playbook' }>['source'] }
			| { kind: 'buyer-link'; value: Extract<ChangeRow, { kind: 'buyer-link' }>['source'] };
		key: string;
		operationId: string;
		policy: 'none' | 'required';
		changes: ContractChange[];
		access: CompanyAccess;
	}) {
		if (mode?.sourceOnly) throw new Error('A source-only session cannot stage changes.');
		if (committed) throw new Error('Transition already committed.');
		if (args.access.companyId !== contract.root.companyId)
			throw new Error('Invalid change actor ownership.');
		const kind = args.source.kind,
			value = await head(kind, args.key);
		if (kind === 'buyer-link' && args.policy !== 'required')
			throw new Error('Buyer proposals require admin approval.');
		if (
			args.source.kind === 'playbook' &&
			(args.key !== args.source.value.itemId ||
				args.source.value.templateVersionId !== contract.root.templateVersionId)
		)
			throw new Error('Invalid frozen playbook source.');
		if (args.source.kind === 'buyer-link' && args.key !== args.source.value.threadId)
			throw new Error('Invalid buyer proposal identity.');
		const predecessors = await ancestors(value.applied);
		if (predecessors.length >= MAX_APPROVED_CHANGE_CHAIN)
			throw new ConvexError('This widget has too many wording revisions.');
		const patchKey = args.operationId;
		if (pendingChanges.some((change) => change.row.patchKey === patchKey))
			throw new ConvexError('Duplicate contract command.');
		const predecessorPatches: DocumentChange[] = [];
		for (const predecessor of predecessors) predecessorPatches.push(await patchFor(predecessor));
		let patch: DocumentChange;
		try {
			patch =
				kind === 'playbook'
					? prepareDocumentTransition(document, predecessorPatches, args.changes, patchKey)
					: prepareDocumentChange(document, args.changes, patchKey);
		} catch (error) {
			if (error instanceof DocumentChangeConflict) throw new ConvexError(error.message);
			throw error;
		}
		patch.annotationKind = kind;
		const next = applyDocumentChange(document, patch);
		assertContractDocumentRenderCapacity(next);
		const approve = args.policy === 'none' || args.access.membership.role === 'admin';
		// Same-view Playbook pending alternatives preserve their existing overlap guarantee.
		// Buyer proposal claims, including raw roots, are admitted by P2 before calling stage.
		if (!approve && kind === 'playbook') await loadPlaybook();
		if (!approve && kind === 'playbook')
			for (const other of heads.values()) {
				if (
					other === value ||
					other.kind !== kind ||
					!other.current ||
					other.current === other.applied ||
					status(other) === 'approved'
				)
					continue;
				const otherPatch = await patchFor(other.current);
				try {
					applyDocumentChange(next, otherPatch);
					applyDocumentChange(applyDocumentChange(document, otherPatch), patch);
				} catch (error) {
					if (!(error instanceof DocumentChangeConflict)) throw error;
					throw new ConvexError('Another pending Playbook option overlaps this wording.');
				}
			}
		const serialized = JSON.stringify(patch),
			dataBytes = new TextEncoder().encode(serialized).length;
		if (dataBytes > 8_000_000)
			throw new ConvexError('This change exceeds supported document capacity.');
		const parts: string[] = [];
		for (let offset = 0; offset < serialized.length;) {
			let end = Math.min(offset + 120 * 1024, serialized.length);
			if (
				serialized.charCodeAt(end - 1) >= 0xd800 &&
				serialized.charCodeAt(end - 1) <= 0xdbff &&
				serialized.charCodeAt(end) >= 0xdc00 &&
				serialized.charCodeAt(end) <= 0xdfff
			)
				end++;
			parts.push(serialized.slice(offset, end));
			offset = end;
		}
		if (parts.length > 64)
			throw new ConvexError('This change exceeds supported document capacity.');
		const common = {
			companyId: contract.root.companyId,
			contractId: contract.root._id,
			key: args.key,
			operationId: args.operationId,
			patchKey,
			actor: changeActorOf(args.access),
			createdAt: Date.now(),
			predecessorId: value.applied?.id,
			policy: args.policy,
			chunks: parts.length,
			dataBytes
		};
		const row: ChangeRow =
			args.source.kind === 'playbook'
				? { ...common, kind: 'playbook', source: args.source.value }
				: { ...common, kind: 'buyer-link', policy: 'required', source: args.source.value };
		const change: SessionChange = { row, patch, parts, predecessor: value.applied };
		pendingChanges.push(change);
		if (value.current?.id && value.current !== value.applied) canceled.add(value.current.id);
		value.current = change;
		value.currentDecision = undefined;
		if (approve) {
			document = next;
			value.applied = change;
			value.appliedDecision = undefined;
			if (args.policy === 'required') record(value, args.access, args.operationId, 'approve');
			await cancelIncompatible(value);
		}
		touch(value);
		return change;
	}
	async function decide(args: DecisionCommand & { access: CompanyAccess }) {
		if (mode?.sourceOnly) throw new Error('A source-only session cannot decide changes.');
		if (committed) throw new Error('Transition already committed.');
		if (
			args.access.companyId !== contract.root.companyId ||
			args.access.membership.role !== 'admin'
		)
			throw new ConvexError('Only an admin can decide this change.');
		const change = await load(args.changeId),
			value = await head(change.row.kind, change.row.key);
		if (
			value.current?.id !== args.changeId ||
			(value.currentDecision?.id ?? null) !== args.expectedDecisionId
		)
			throw new ConvexError('This change was replaced or reviewed. Review its current state.');
		if (args.action === 'approve' && status(value) === 'approved') return false;
		if (args.action === 'decline' && status(value) === 'rejected') return false;
		if (
			args.action === 'undo' &&
			(change.row.kind !== 'buyer-link' || value.applied !== value.current)
		)
			throw new ConvexError('This buyer proposal is no longer applied.');
		if (args.action === 'decline' && value.applied === value.current)
			throw new ConvexError(
				'Remove an applied option through the Playbook, or undo an applied buyer proposal.'
			);
		if (args.action === 'undo') {
			const eligibility = await undoEligibility(value);
			if (!eligibility.allowed) throw new ConvexError(eligibility.reason!);
			document = reverseDocumentChange(document, await patchFor(change));
			value.applied =
				change.predecessor ??
				(change.row.predecessorId ? await load(change.row.predecessorId) : undefined);
			value.appliedDecision =
				value.applied?.row.policy === 'required' ? await latestApproval(value.applied) : undefined;
		} else if (args.action === 'approve') {
			let next: ContractDocument;
			try {
				next = applyDocumentChange(document, await patchFor(change));
			} catch (error) {
				if (error instanceof DocumentChangeConflict) throw new ConvexError(error.message);
				throw error;
			}
			assertContractDocumentRenderCapacity(next);
			document = next;
			value.applied = change;
		}
		record(value, args.access, args.operationId, args.action);
		if (args.action === 'undo') {
			value.current = value.applied;
			value.currentDecision = value.appliedDecision;
		}
		if (args.action !== 'decline') await cancelIncompatible(value);
		touch(value);
		return true;
	}
	async function latestApproval(change: SessionChange): Promise<SessionDecision> {
		const pending = pendingDecisions.findLast(
			(entry) => entry.change === change && entry.row.status === 'approved'
		);
		if (pending) return pending;
		if (!change.id) throw new Error('Missing applied approval.');
		const row = await ctx.db
			.query('contractChangeDecisions')
			.withIndex('by_changeId_and_decidedAt', (q) => q.eq('changeId', change.id!))
			.order('desc')
			.first();
		if (!row || row.status !== 'approved')
			throw new ConvexError('Previous wording needs renewed authorization.');
		return (await decision(row._id, change))!;
	}
	async function withdraw(kind: ChangeKind, key: string, expectedChangeId?: Id<'contractChanges'>) {
		if (committed) throw new Error('Transition already committed.');
		const value = await head(kind, key);
		if (expectedChangeId && value.current?.id !== expectedChangeId)
			throw new ConvexError('This change was replaced.');
		if (!value.current) return false;
		if (value.current === value.applied)
			throw new ConvexError('Use a reviewed removal to remove applied wording.');
		restore(value);
		return true;
	}
	function plan(): TransitionPlan {
		const documentChanged = !mode?.sourceOnly && canonicalJson(before) !== canonicalJson(document);
		const changedContexts = new Set<'playbook' | 'buyer-link'>();
		for (const value of heads.values())
			if (value.dirty) {
				const previous = value.initial;
				const oldTuple =
					previous?.current?.policy === 'required'
						? [previous.current._id, currentDecisionId(previous.head.current)]
						: null;
				const nextTuple =
					value.current?.row.policy === 'required'
						? [
								value.current.id ?? value.current.row.patchKey,
								value.currentDecision?.id ?? value.currentDecision?.row.operationId ?? null
							]
						: null;
				if (canonicalJson(oldTuple) !== canonicalJson(nextTuple)) changedContexts.add(value.kind);
			}
		return {
			before: mode?.sourceOnly ? null : before,
			after: mode?.sourceOnly ? null : document,
			...(mode?.sourceOnly ? { sourceTapeLength: mode.sourceOnly.tapeLength } : {}),
			documentChanged,
			canceledChangeIds: [...canceled],
			changedContexts: [...changedContexts],
			heads: [...heads.values()].filter((value) => value.dirty),
			identity: bytesToHex(
				sha256(
					new TextEncoder().encode(
						canonicalJson([
							contract.root.documentId,
							contract.root.documentRevision,
							[...heads.values()]
								.filter((value) => value.dirty)
								.map((value) => [
									value.kind,
									value.key,
									value.stored?.current?.changeId ?? null,
									currentDecisionId(value.stored?.current ?? null),
									value.stored?.applied?.changeId ?? null,
									value.current?.row.patchKey ?? null,
									value.currentDecision?.row.operationId ?? null,
									value.applied?.row.patchKey ?? null
								]),
							pendingChanges.map((change) => [
								change.row.patchKey,
								change.row.kind,
								change.row.key,
								change.row.source,
								change.row.policy,
								change.row.actor.profileId,
								change.patch
							]),
							[...canceled]
						])
					)
				)
			)
		};
	}
	async function commit(options: {
		access?: CompanyAccess;
		sourceWithdrawal?: {
			companyId: Id<'company'>;
			authorKey: string;
			threadId: Id<'discussionThreads'>;
			rootMessageId: Id<'discussionMessages'>;
			rootRevision: number;
		};
		operationId: string;
		hooks?: TransitionHooks;
		reserveTail?: (root: CurrentContractRoot) => Promise<TransitionWork>;
	}) {
		if (committed) throw new Error('Transition already committed.');
		if (
			(options.access?.companyId ?? options.sourceWithdrawal?.companyId) !== contract.root.companyId
		)
			throw new Error('Invalid commit actor.');
		if (!mode?.sourceOnly)
			await options.hooks?.beforePlan?.({
				before,
				after: document,
				pendingBuyerProposals: [...heads.values()].flatMap((value) =>
					value.current?.row.kind === 'buyer-link' &&
					value.current !== value.applied &&
					status(value) !== 'approved'
						? [
								{
									changeId: value.current.id ?? null,
									key: value.key,
									source: value.current.row.source
								}
							]
						: []
				),
				withdraw: async (key, expectedChangeId) => {
					const value = await head('buyer-link', key);
					if (
						!value.current ||
						(value.current.id ?? null) !== expectedChangeId ||
						value.current === value.applied
					)
						throw new Error('Pre-plan support identity changed.');
					restore(value);
				}
			});
		const transition = plan(),
			dirtyHeads = [...heads.values()].filter((value) => value.dirty);
		if (!dirtyHeads.length) {
			await admitTransition(ctx, (await options.reserveTail?.(contract.root)) ?? {});
			committed = true;
			return { changed: false, plan: transition, contract };
		}
		if (
			(mode?.sourceOnly || !options.access) &&
			(!options.sourceWithdrawal ||
				transition.documentChanged ||
				pendingChanges.length ||
				pendingDecisions.length ||
				dirtyHeads.length !== 1 ||
				dirtyHeads.some(
					(value) =>
						value.kind !== 'buyer-link' ||
						value.current !== value.applied ||
						value.initial?.current?.kind !== 'buyer-link' ||
						value.initial.current.source.threadId !== options.sourceWithdrawal?.threadId ||
						value.initial.current.source.rootMessageId !==
							options.sourceWithdrawal?.rootMessageId ||
						value.initial.current.source.rootRevision !== options.sourceWithdrawal?.rootRevision
				))
		)
			throw new Error('A discussion author may only withdraw exact floating support.');
		const selectedPlaybook = (value: SessionHead) => {
			const row = sessionHeadRow(value);
			return row?.kind === 'playbook' && row.activePlaybook;
		};
		const playbookSelectionCount =
			contract.root.playbookSelectionCount +
			dirtyHeads.reduce(
				(sum, value) =>
					sum +
					Number(selectedPlaybook(value)) -
					Number(value.stored?.kind === 'playbook' && value.stored.activePlaybook),
				0
			);
		if (playbookSelectionCount < 0 || playbookSelectionCount > MAX_SELECTED_CONCESSIONS)
			throw new ConvexError('Too many selected Playbook options.');
		const playbookCounts = {
			playbookReviewCount: contract.root.playbookReviewCount,
			playbookPendingCount: contract.root.playbookPendingCount,
			playbookDeclinedCount: contract.root.playbookDeclinedCount
		};
		for (const value of dirtyHeads)
			if (value.kind === 'playbook') {
				const previous = value.initial;
				const oldRequired = previous?.current?.policy === 'required';
				const nextRequired = value.current?.row.policy === 'required';
				playbookCounts.playbookReviewCount += Number(nextRequired) - Number(oldRequired);
				playbookCounts.playbookPendingCount +=
					Number(nextRequired && status(value) === 'pending') -
					Number(oldRequired && previous?.head.status === 'pending');
				playbookCounts.playbookDeclinedCount +=
					Number(nextRequired && status(value) === 'rejected') -
					Number(oldRequired && previous?.head.status === 'rejected');
			}
		if (Object.values(playbookCounts).some((count) => !Number.isSafeInteger(count) || count < 0))
			throw new Error('Invalid Playbook review counters.');
		if (!mode?.sourceOnly) assertContractDocumentRenderCapacity(document);
		const prepared = await options.hooks?.beforeCommit?.(transition);
		const documentPlan = transition.documentChanged
			? await prepareContractDocument(ctx, {
					companyId: contract.root.companyId,
					contractId: contract.root._id,
					document,
					previousDocumentId: contract.root.documentId
				})
			: null;

		const reviewGroup = (context: ChangeKind): CurrentContractRoot['reviews']['playbook'] => {
			const previous = contract.root.reviews[reviewGroupKey(context)];
			if (!transition.changedContexts.includes(context)) return previous;
			const identity = contextIdentity([
				previous.identity,
				options.access?.membershipId ?? options.sourceWithdrawal?.authorKey,
				options.operationId,
				transition.identity,
				...(context === 'buyer-link' ? [transition.supportCommitment ?? null] : [])
			]);
			const completion = options.access
				? changedContextCompletion(
						identity,
						context === 'playbook'
							? playbookCounts.playbookReviewCount
							: (transition.buyerReviewCount ?? 0),
						context === 'playbook'
							? playbookCounts.playbookPendingCount
							: (transition.supportCommitment?.pendingCount ?? 0),
						options.access
					)
				: undefined;
			return { identity, ...(completion ? { completion } : {}) };
		};
		const rootFields = {
			documentId: (documentPlan?.existingId ??
				(documentPlan ? placeholder : contract.root.documentId)) as Id<'contractDocuments'>,
			documentRevision:
				contract.root.documentRevision + (documentPlan && !documentPlan.existingId ? 1 : 0),
			stateRevision: contract.root.stateRevision + 1,
			playbookSelectionCount,
			...playbookCounts,
			savedAt: Date.now(),
			...(options.access
				? { lastOperation: { id: options.operationId, callerId: options.access.profile._id } }
				: {}),
			reviews: { playbook: reviewGroup('playbook'), buyerLink: reviewGroup('buyer-link') }
		};
		const directory = await ctx.db
			.query('contractDirectory')
			.withIndex('by_contractId', (q) => q.eq('contractId', contract.root._id))
			.unique();
		if (!directory) throw new Error('Native commit lost the contract directory.');
		const buyerCurrent = await prepareBuyerCurrentView(
			ctx,
			contract.root,
			{ ...contract.root, ...rootFields },
			documentPlan?.fingerprint
		);
		const tail = (await options.reserveTail?.({ ...contract.root, ...rootFields })) ?? {},
			hookWork = (await options.hooks?.reserve?.(transition)) ?? {};
		const measured = (row: Record<string, import('convex/values').Value | undefined>) =>
			documentBytes({ ...row, _id: placeholder, _creationTime: 0 });
		let writeDocuments = (documentPlan?.work.documents ?? 0) + 2,
			writeBytes =
				(documentPlan?.work.bytes ?? 0) +
				measured({ ...contract.root, ...rootFields }) +
				measured({
					...directory,
					savedAt: rootFields.savedAt,
					hasUnreadComment: prepared?.hasUnreadComment ?? directory.hasUnreadComment
				});
		for (const change of pendingChanges) {
			writeDocuments += 1 + change.parts!.length;
			writeBytes += measured({ ...change.row, predecessorId: plannedId(change.predecessor) });
			for (const [order, data] of change.parts!.entries())
				writeBytes += measured({
					companyId: contract.root.companyId,
					contractId: contract.root._id,
					changeId: placeholder,
					order,
					data
				});
		}
		for (const entry of pendingDecisions) {
			writeDocuments++;
			writeBytes += measured({ ...entry.row, changeId: plannedId(entry.change) });
		}
		for (const value of dirtyHeads) {
			writeDocuments++;
			const row = sessionHeadRow(value);
			if (row) writeBytes += measured(row);
		}
		await admitTransition(ctx, {
			documents:
				writeDocuments +
				(tail.documents ?? 0) +
				(hookWork.documents ?? 0) +
				(buyerCurrent.work.documents ?? 0),
			bytes:
				writeBytes + (tail.bytes ?? 0) + (hookWork.bytes ?? 0) + (buyerCurrent.work.bytes ?? 0),
			queries: 1 + (tail.queries ?? 0) + (hookWork.queries ?? 0) + (buyerCurrent.work.queries ?? 0),
			readDocuments: 1 + (tail.readDocuments ?? 0) + (hookWork.readDocuments ?? 0),
			readBytes: measured(directory) + (tail.readBytes ?? 0) + (hookWork.readBytes ?? 0),
			functionsScheduled: (tail.functionsScheduled ?? 0) + (hookWork.functionsScheduled ?? 0),
			scheduledFunctionArgsBytes:
				(tail.scheduledFunctionArgsBytes ?? 0) + (hookWork.scheduledFunctionArgsBytes ?? 0)
		});

		for (const change of pendingChanges) {
			change.id = await ctx.db.insert('contractChanges', {
				...change.row,
				predecessorId: change.predecessor?.id
			});
			for (const [order, data] of change.parts!.entries())
				await ctx.db.insert('contractChangeContents', {
					companyId: contract.root.companyId,
					contractId: contract.root._id,
					changeId: change.id,
					order,
					data
				});
		}
		for (const entry of pendingDecisions) {
			if (!entry.change.id) throw new Error('Missing committed decision target.');
			entry.id = await ctx.db.insert('contractChangeDecisions', {
				...entry.row,
				changeId: entry.change.id
			});
		}
		for (const value of dirtyHeads) {
			if (!value.current && !value.applied) {
				if (value.stored) await ctx.db.delete('contractChangeHeads', value.stored._id);
				continue;
			}
			const row = sessionHeadRow(value);
			if (!row) throw new Error('A nonempty session produced no head.');
			if (value.stored) await ctx.db.replace('contractChangeHeads', value.stored._id, row);
			else await ctx.db.insert('contractChangeHeads', row);
		}
		await options.hooks?.afterChanges?.(transition);
		rootFields.documentId = documentPlan
			? await commitContractDocument(ctx, documentPlan)
			: contract.root.documentId;
		await patchContract(ctx, contract, rootFields, {
			...prepared,
			directoryRow: directory,
			buyerCurrent
		});
		await options.hooks?.afterCommit?.(transition, contract);
		committed = true;
		return { changed: true, plan: transition, contract };
	}
	function playbookStates(base: readonly PlaybookState[]): PlaybookState[] {
		const result = new Map(base.map((state) => [state.itemId, state]));
		for (const value of heads.values())
			if (value.kind === 'playbook' && value.dirty) {
				if (!value.current && !value.applied) {
					result.delete(value.key as Id<'playbookItems'>);
					continue;
				}
				const row = sessionHeadRow(value);
				if (!row) throw new Error('Missing Playbook projection.');
				const state = playbookProjection(row);
				if (!state) throw new Error('Invalid Playbook projection.');
				result.set(state.itemId, state);
			}
		return [...result.values()];
	}

	return {
		stage,
		playbookStates,
		decide,
		withdraw,
		head,
		status,
		undoEligibility,
		plan,
		commit,
		get document() {
			if (mode?.sourceOnly)
				throw new Error('A source-only withdrawal has no document materialization.');
			return document;
		}
	};
}
