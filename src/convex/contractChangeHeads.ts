import type { Infer } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { ChangeKind, PlaybookState } from '../lib/contract/changes';
import type { storedContractChange, storedContractChangeHead } from './contractChangeValidators';

export type ChangeHead = Infer<typeof storedContractChangeHead>;
type CurrentBundle = ChangeHead['current'];
type AppliedBundle = ChangeHead['applied'];
type ChangeRow = Infer<typeof storedContractChange>;
/** Exact identity and bounded source projection used by native sealed snapshots.
 * Full immutable rows satisfy this shape without adding patch/authoring data. */
export type HeadChangeSource = Pick<ChangeRow, 'companyId' | 'contractId' | 'key'> &
	(
		| {
				kind: 'playbook';
				policy: 'none' | 'required';
				source: Pick<Extract<ChangeRow, { kind: 'playbook' }>['source'], 'itemId' | 'optionId'>;
		  }
		| {
				kind: 'buyer-link';
				policy: 'required';
				source: Pick<Extract<ChangeRow, { kind: 'buyer-link' }>['source'], 'threadId'>;
		  }
	);
export type HeadActivation = {
	changeId: Id<'contractChanges'>;
	change: HeadChangeSource;
	decisionId?: Id<'contractChangeDecisions'>;
	admissionRevision?: number;
};

export const currentDecisionId = (bundle: CurrentBundle) =>
	bundle && 'review' in bundle && bundle.review.kind === 'decided'
		? bundle.review.decisionId
		: null;
export const appliedDecisionId = (bundle: AppliedBundle) =>
	bundle && 'decisionId' in bundle ? bundle.decisionId : null;
export const pendingAdmissionRevision = (bundle: CurrentBundle) =>
	bundle && 'review' in bundle && bundle.review.kind === 'pending'
		? bundle.review.admissionRevision
		: null;
export const activePlaybook = (
	head: Pick<Extract<ChangeHead, { kind: 'playbook' }>, 'current' | 'applied'>
) => [head.current, head.applied].some((bundle) => bundle && bundle.optionId !== null);

/** Pure consistency checks shared by bounded projections and hydrated authority reads.
 * Decision outcomes are always checked against the authoritative decision record. */
export function assertChangeHead(head: ChangeHead) {
	if (!head.current && !head.applied) throw new Error('An empty change head must be deleted.');
	const admission = pendingAdmissionRevision(head.current);
	if (admission !== null && (!Number.isSafeInteger(admission) || admission < 1))
		throw new Error('Invalid change activation admission revision.');
	if (head.kind === 'playbook' && head.activePlaybook !== activePlaybook(head))
		throw new Error('Playbook selection projection is invalid.');
	if (head.current && head.current.changeId === head.applied?.changeId) {
		if (currentDecisionId(head.current) !== appliedDecisionId(head.applied))
			throw new Error('Current and applied approval references differ.');
		if (
			head.kind === 'playbook' &&
			(head.current.policy !== head.applied.policy ||
				head.current.optionId !== head.applied.optionId)
		)
			throw new Error('Current and applied Playbook projections differ.');
	}
	if (
		head.kind === 'playbook' &&
		head.current?.policy === 'none' &&
		head.current.changeId !== head.applied?.changeId
	)
		throw new Error('Unreviewed wording must be applied atomically.');
}

function projectHead(
	head:
		| Omit<Extract<ChangeHead, { kind: 'playbook' }>, 'activePlaybook'>
		| Extract<ChangeHead, { kind: 'buyer-link' }>
): ChangeHead | null {
	if (!head.current && !head.applied) return null;
	const result: ChangeHead =
		head.kind === 'playbook' ? { ...head, activePlaybook: activePlaybook(head) } : head;
	assertChangeHead(result);
	return result;
}

/** Sole head constructor for ordinary and staged writers. IDs and projections are
 * captured together from exact source records; an empty result means delete. */
export function createChangeHead(args: {
	companyId: Id<'company'>;
	contractId: Id<'savedContracts'>;
	kind: ChangeKind;
	key: string;
	current: HeadActivation | null;
	applied: HeadActivation | null;
}): ChangeHead | null {
	const { companyId, contractId, kind, key, current, applied } = args;
	for (const activation of [current, applied]) {
		if (!activation) continue;
		const row = activation.change;
		if (
			('_id' in row && row._id !== activation.changeId) ||
			row.companyId !== companyId ||
			row.contractId !== contractId ||
			row.kind !== kind ||
			row.key !== key ||
			(row.kind === 'playbook' ? row.source.itemId : row.source.threadId) !== key
		)
			throw new Error('Invalid change head source identity.');
		if (row.kind === 'buyer-link' && row.policy !== 'required')
			throw new Error('Buyer-link changes require approval.');
		if (row.policy === 'none' && activation.decisionId)
			throw new Error('Unreviewed wording cannot carry a decision.');
	}
	const review = (activation: HeadActivation) => {
		if (activation.decisionId)
			return { kind: 'decided' as const, decisionId: activation.decisionId };
		if (activation.admissionRevision === undefined)
			throw new Error('Pending activation has no admission revision.');
		return { kind: 'pending' as const, admissionRevision: activation.admissionRevision };
	};
	const approval = (activation: HeadActivation) => {
		if (!activation.decisionId) throw new Error('Applied wording has no exact approval.');
		return activation.decisionId;
	};
	const owner = { companyId, contractId, key };
	if (kind === 'buyer-link')
		return projectHead({
			...owner,
			kind,
			current: current && { changeId: current.changeId, review: review(current) },
			applied: applied && { changeId: applied.changeId, decisionId: approval(applied) }
		});
	const playbook = (activation: HeadActivation) => {
		if (activation.change.kind !== 'playbook') throw new Error('Invalid Playbook source.');
		return { changeId: activation.changeId, optionId: activation.change.source.optionId };
	};
	return projectHead({
		...owner,
		kind,
		current:
			current &&
			(current.change.policy === 'none'
				? { ...playbook(current), policy: 'none' }
				: { ...playbook(current), policy: 'required', review: review(current) }),
		applied:
			applied &&
			(applied.change.policy === 'none'
				? { ...playbook(applied), policy: 'none' }
				: { ...playbook(applied), policy: 'required', decisionId: approval(applied) })
	});
}

/** Applied evidence remains sufficient after the original discussion is deleted. */
export function restoreAppliedHead(head: ChangeHead): ChangeHead | null {
	assertChangeHead(head);
	const { companyId, contractId, key } = head;
	if (head.kind === 'buyer-link')
		return projectHead({
			companyId,
			contractId,
			key,
			kind: head.kind,
			current: head.applied && {
				changeId: head.applied.changeId,
				review: { kind: 'decided', decisionId: head.applied.decisionId }
			},
			applied: head.applied
		});
	return projectHead({
		companyId,
		contractId,
		key,
		kind: head.kind,
		current:
			head.applied &&
			(head.applied.policy === 'none'
				? head.applied
				: {
						changeId: head.applied.changeId,
						optionId: head.applied.optionId,
						policy: 'required',
						review: { kind: 'decided', decisionId: head.applied.decisionId }
					}),
		applied: head.applied
	});
}

/** This compact view does not fetch patches or decisions. A decided current bundle
 * which differs from applied can only be rejected; hydration checks that relation. */
export function playbookProjection(head: ChangeHead): PlaybookState | null {
	assertChangeHead(head);
	if (head.kind !== 'playbook') return null;
	return {
		itemId: head.key as Id<'playbookItems'>,
		currentChangeId: head.current?.changeId ?? null,
		appliedChangeId: head.applied?.changeId ?? null,
		currentOptionId: head.current?.optionId ?? null,
		appliedOptionId: head.applied?.optionId ?? null,
		status:
			!head.current ||
			head.current.policy === 'none' ||
			head.current.changeId === head.applied?.changeId
				? 'approved'
				: head.current.review.kind === 'pending'
					? 'pending'
					: 'rejected',
		decisionId: currentDecisionId(head.current)
	};
}

/** Verify every bundled projection against immutable change data without storing a
 * second copy of IDs, policy, or option state. */
export function assertHeadChange(head: ChangeHead, role: 'current' | 'applied', row: ChangeRow) {
	const bundle = head[role];
	if (
		!bundle ||
		('_id' in row && row._id !== bundle.changeId) ||
		row.companyId !== head.companyId ||
		row.contractId !== head.contractId ||
		row.kind !== head.kind ||
		row.key !== head.key ||
		(row.kind === 'playbook' ? row.source.itemId : row.source.threadId) !== head.key
	)
		throw new Error('Invalid native change identity.');
	if (row.kind === 'buyer-link') {
		if (row.policy !== 'required') throw new Error('Buyer-link change has no required policy.');
	} else if (
		!('policy' in bundle) ||
		row.policy !== bundle.policy ||
		!('optionId' in bundle) ||
		row.source.optionId !== bundle.optionId
	)
		throw new Error('Invalid Playbook change projection.');
}
