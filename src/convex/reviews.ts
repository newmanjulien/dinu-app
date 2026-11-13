import type { PaginationOptions } from 'convex/server';
import { DiscussionIndex } from './discussionIndex';
import { DiscussionPreparationRequired } from './discussionMaps';
import type { Doc } from './_generated/dataModel';
import type { CompanyAccess } from './auth';
import type { Contract } from './contractState';
import type { QueryCtx } from './_generated/server';
import type {
	ChangeKind,
	ChangeReview,
	ApprovalContext,
	PlaybookState
} from '../lib/contract/changes';
import {
	applyDocumentChange,
	reverseDocumentChange,
	DocumentChangeConflict,
	type ContractDocument,
	type DocumentChange,
	documentMapping,
	mapDocumentTarget
} from '../lib/document/contract-document';
import { approvedDocument, playbookStateOf, hydrateHead, readChange } from './contractChanges';

/** Context-local semantic tokens and exact counters replace whole-head identities. */
export async function reviewSet(ctx: QueryCtx, contract: Contract, context: ApprovalContext) {
	const summary =
		context === 'buyer-link'
			? (await DiscussionIndex.open(ctx, contract.root)).supportSummary
			: null;
	const count = summary?.reviewCount ?? contract.root.playbookReviewCount;
	const pendingCount = summary?.pendingCount ?? contract.root.playbookPendingCount;
	return {
		context,
		identity:
			context === 'playbook'
				? contract.root.playbookReviewIdentity
				: contract.root.buyerLinkReviewIdentity,
		count,
		pendingCount,
		declinedCount: summary?.declinedCount ?? contract.root.playbookDeclinedCount,
		complete: count > 0 && pendingCount === 0
	};
}
/** Native bounds/cursor metadata survive effective filtering, including empty pages. */
export async function changeHeadPage(
	ctx: QueryCtx,
	contract: Contract,
	paginationOpts: PaginationOptions,
	kind?: ChangeKind
) {
	const query = kind
		? ctx.db
				.query('contractChangeHeads')
				.withIndex('by_contractId_and_kind', (q) =>
					q.eq('contractId', contract.root._id).eq('kind', kind)
				)
		: ctx.db
				.query('contractChangeHeads')
				.withIndex('by_contractId', (q) => q.eq('contractId', contract.root._id));
	const native = await query.paginate({
		...paginationOpts,
		numItems: Math.max(1, Math.min(8, paginationOpts.numItems)),
		maximumRowsRead: Math.min(8, paginationOpts.maximumRowsRead ?? 8),
		maximumBytesRead: Math.min(128 * 1024, paginationOpts.maximumBytesRead ?? 128 * 1024)
	});
	const index = await DiscussionIndex.open(ctx, contract.root);
	const page = [];
	for (const row of native.page) {
		const item = await hydrateHead(ctx, contract, row, index);
		if (item.current || item.applied) page.push(item);
	}
	return { ...native, page };
}
/** Exact committed counts certify readiness without hydrating any head or document. */
export async function contractReadinessState(ctx: QueryCtx, contract: Contract) {
	const summary = (await DiscussionIndex.open(ctx, contract.root)).supportSummary;
	const blockerCount =
		summary.pendingCount +
		summary.declinedCount +
		contract.root.playbookPendingCount +
		contract.root.playbookDeclinedCount;
	return {
		expectation: {
			stateRevision: contract.root.stateRevision,
			documentId: contract.root.documentId,
			documentRevision: contract.root.documentRevision
		},
		blockerCount,
		ready: blockerCount === 0
	};
}
/** Counts establish exact readiness; bounded details never certify by a partial scan. */
export async function contractReadiness(
	ctx: QueryCtx,
	contract: Contract,
	paginationOpts: PaginationOptions = { numItems: 32, cursor: null }
) {
	const state = await contractReadinessState(ctx, contract);
	const { page, ...pagination } = await changeHeadPage(ctx, contract, paginationOpts);
	const blockers = page.flatMap(({ head, current }) =>
		current?.policy === 'required' && head.status !== 'approved'
			? [
					{
						changeId: current._id,
						kind: current.kind,
						reason:
							head.status === 'pending'
								? 'This change needs admin approval.'
								: 'This selected change was declined.'
					}
				]
			: []
	);
	return { ...state, blockers, pagination };
}
export async function playbookStates(ctx: QueryCtx, contract: Contract): Promise<PlaybookState[]> {
	const template = await ctx.db.get('templateVersions', contract.root.templateVersionId);
	if (!template || template.companyId !== contract.root.companyId)
		throw new Error('Playbook state has no frozen template.');
	const ids = new Set(template.items.map((item) => String(item.itemId)));
	const rows = await ctx.db
		.query('contractChangeHeads')
		.withIndex('by_contractId_and_kind', (q) =>
			q.eq('contractId', contract.root._id).eq('kind', 'playbook')
		)
		.take(template.items.length + 1);
	if (rows.length > template.items.length)
		throw new Error('Playbook state exceeds its frozen template.');
	const result: PlaybookState[] = [];
	for (const row of rows) {
		if (row.companyId !== contract.root.companyId || !ids.has(row.key))
			throw new Error('Playbook state ownership failed.');
		const state = playbookStateOf(row);
		if (state) result.push(state);
	}
	return result;
}
/** Pure shared review presentation; unresolved means load the focused immutable detail.
 * Capacity/transport errors are never misreported as an inapplicable change. */
export function reviewOf(
	contract: Contract,
	admin: boolean,
	head: Awaited<ReturnType<typeof hydrateHead>>['head'],
	current: Doc<'contractChanges'> | null,
	applied: Doc<'contractChanges'> | null,
	row: Doc<'contractChanges'>,
	document: ContractDocument | null,
	patch: DocumentChange | null,
	mapping?: ReturnType<typeof documentMapping>
): ChangeReview {
	const isCurrent = row._id === current?._id,
		isApplied = row._id === applied?._id,
		sourceTarget =
			row.kind === 'playbook'
				? row.source.target
				: {
						kind: 'text' as const,
						range: { start: row.source.anchor.start.point, end: row.source.anchor.end.point }
					};
	let target: ChangeReview['target'] = null;
	if (document)
		try {
			target = mapDocumentTarget(
				document,
				sourceTarget,
				true,
				mapping ?? documentMapping(document)
			);
		} catch {
			/* Exact gutter fallback. */
		}
	let applicability: string | null = null,
		undoConflict: string | null = null;
	if (document && patch) {
		try {
			if (isCurrent && !isApplied) applyDocumentChange(document, patch);
		} catch (error) {
			if (!(error instanceof DocumentChangeConflict)) throw error;
			applicability = error.message;
		}
		try {
			if (isApplied && row.kind === 'buyer-proposal' && isCurrent)
				reverseDocumentChange(document, patch);
		} catch (error) {
			if (!(error instanceof DocumentChangeConflict)) throw error;
			undoConflict = error.message;
		}
	}
	const status = isCurrent ? head.status : 'approved';
	const approveReason = !admin
		? 'Only an admin can approve this change.'
		: !isCurrent
			? 'This change was replaced.'
			: status === 'approved'
				? 'This change is already approved.'
				: applicability;
	const declineReason = !admin
		? 'Only an admin can decline this change.'
		: !isCurrent
			? 'This change was replaced.'
			: isApplied
				? 'Remove this option through the Playbook, or undo this buyer proposal.'
				: status === 'rejected'
					? 'This change was already declined.'
					: null;
	const undoReason = !admin
		? 'Only an admin can undo this proposal.'
		: row.kind !== 'buyer-proposal' || !isApplied
			? 'Only an applied buyer proposal can be undone.'
			: !isCurrent
				? 'This buyer proposal is no longer the applied head.'
				: undoConflict;
	const resolved = Boolean(document && patch);
	return {
		changeId: row._id,
		kind: row.kind,
		key: row.key,
		action: row.kind === 'playbook' && row.source.optionId === null ? 'remove' : 'apply',
		description: row.kind === 'playbook' ? row.source.description : row.source.text,
		status,
		currentChangeId: head.currentChangeId ?? null,
		appliedChangeId: head.appliedChangeId ?? null,
		decisionId: (isCurrent ? head.currentDecisionId : head.appliedDecisionId) ?? null,
		target,
		previewIdentity: `${contract.root.documentId}:${row._id}`,
		detailRequired: !document || (!resolved && (approveReason === null || undoReason === null)),
		approve: {
			allowed: approveReason !== null ? false : resolved ? true : null,
			reason: approveReason
		},
		decline: { allowed: declineReason === null, reason: declineReason },
		undo: { allowed: undoReason !== null ? false : resolved ? true : null, reason: undoReason }
	};
}
/** Page metadata stays native; one shared document and one patch per distinct row. */
export async function changeReviews(
	ctx: QueryCtx,
	contract: Contract,
	access: CompanyAccess,
	paginationOpts: PaginationOptions,
	kind?: ChangeKind
) {
	const { page: heads, ...pagination } = await changeHeadPage(ctx, contract, paginationOpts, kind),
		result: ChangeReview[] = [];
	let document: ContractDocument | null = null;
	if (heads.length)
		try {
			document = await approvedDocument(ctx, contract, { deferOnCapacity: true });
		} catch (error) {
			if (!(error instanceof DiscussionPreparationRequired)) throw error;
		}
	const mapping = document ? documentMapping(document) : undefined;
	for (const { head, current, applied } of heads)
		for (const row of [current, ...(applied && applied._id !== current?._id ? [applied] : [])]) {
			if (!row) continue;
			let patch: DocumentChange | null = null;
			const needsPatch =
				access.membership.role === 'admin' &&
				((row._id === current?._id && row._id !== applied?._id) ||
					(row.kind === 'buyer-proposal' && row._id === applied?._id && row._id === current?._id));
			if (document && needsPatch)
				try {
					patch = (await readChange(ctx, row._id, contract, { deferOnCapacity: true, row })).patch;
				} catch (error) {
					if (!(error instanceof DiscussionPreparationRequired)) throw error;
				}
			result.push(
				reviewOf(
					contract,
					access.membership.role === 'admin',
					head,
					current,
					applied,
					row,
					document,
					patch,
					mapping
				)
			);
		}
	return { ...pagination, page: result };
}
