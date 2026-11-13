import { v, convexToJson, type Infer, type Value } from 'convex/values';
import { discussionAnchor } from '../discussions/validators';
import { sourceTarget } from '../document/source-validators';

/** Native contract changes are independent of template authoring origins. */
export const changeKind = v.union(v.literal('playbook'), v.literal('buyer-proposal'));
export const approvalContext = v.union(v.literal('playbook'), v.literal('buyer-link'));
export const changeStatus = v.union(
	v.literal('pending'),
	v.literal('approved'),
	v.literal('rejected')
);
export const changeActor = v.object({
	profileId: v.id('profiles'),
	name: v.string(),
	email: v.string()
});
export const playbookSource = v.object({
	templateVersionId: v.id('templateVersions'),
	itemId: v.id('playbookItems'),
	optionId: v.union(v.string(), v.null()),
	description: v.string(),
	target: sourceTarget
});
export const buyerProposalSource = v.object({
	author: v.object({ authorKey: v.string(), profileId: v.union(v.id('profiles'), v.null()) }),
	threadId: v.id('discussionThreads'),
	rootMessageId: v.id('discussionMessages'),
	rootRevision: v.number(),
	text: v.string(),
	anchor: discussionAnchor,
	quote: v.string(),
	documentId: v.id('contractDocuments'),
	documentRevision: v.number(),
	displayIdentity: v.string()
});

/** Set-to-base removes an applied option; withdrawing only removes a pending transition. */
export const playbookCommand = v.object({
	id: v.string(),
	itemId: v.id('playbookItems'),
	expectedCurrentChangeId: v.union(v.id('contractChanges'), v.null()),
	occurredAt: v.number(),
	action: v.union(
		v.object({ kind: v.literal('set'), optionId: v.union(v.string(), v.null()) }),
		v.object({ kind: v.literal('withdraw') })
	)
});
export const decisionAction = v.union(
	v.literal('approve'),
	v.literal('decline'),
	v.literal('undo')
);
export const decisionCommand = v.object({
	changeId: v.id('contractChanges'),
	expectedDecisionId: v.union(v.id('contractChangeDecisions'), v.null()),
	action: decisionAction,
	operationId: v.string()
});
export const actionEligibility = v.object({
	allowed: v.union(v.boolean(), v.null()),
	reason: v.union(v.string(), v.null())
});
export const changeReview = v.object({
	changeId: v.id('contractChanges'),
	kind: changeKind,
	key: v.string(),
	action: v.union(v.literal('apply'), v.literal('remove')),
	description: v.string(),
	status: changeStatus,
	currentChangeId: v.union(v.id('contractChanges'), v.null()),
	appliedChangeId: v.union(v.id('contractChanges'), v.null()),
	decisionId: v.union(v.id('contractChangeDecisions'), v.null()),
	target: v.union(sourceTarget, v.null()),
	previewIdentity: v.string(),
	detailRequired: v.boolean(),
	approve: actionEligibility,
	decline: actionEligibility,
	undo: actionEligibility
});
export const playbookState = v.object({
	itemId: v.id('playbookItems'),
	currentChangeId: v.union(v.id('contractChanges'), v.null()),
	appliedChangeId: v.union(v.id('contractChanges'), v.null()),
	currentOptionId: v.union(v.string(), v.null()),
	appliedOptionId: v.union(v.string(), v.null()),
	status: changeStatus,
	decisionId: v.union(v.id('contractChangeDecisions'), v.null())
});
export type ChangeKind = Infer<typeof changeKind>;
export type ApprovalContext = Infer<typeof approvalContext>;
export type ChangeStatus = Infer<typeof changeStatus>;
export type ChangeActor = Infer<typeof changeActor>;
export type PlaybookCommand = Infer<typeof playbookCommand>;
export type DecisionCommand = Infer<typeof decisionCommand>;
export type ChangeReview = Infer<typeof changeReview>;
export type PlaybookState = Infer<typeof playbookState>;
export const contextForChange = (kind: ChangeKind): ApprovalContext =>
	kind === 'playbook' ? 'playbook' : 'buyer-link';

export const MAX_SAVE_COMMANDS = 25;

export const nativePageMetadata = v.object({
	continueCursor: v.string(),
	isDone: v.boolean(),
	splitCursor: v.optional(v.union(v.string(), v.null())),
	pageStatus: v.optional(
		v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null())
	)
});
export const reviewSummary = v.object({
	context: approvalContext,
	identity: v.string(),
	count: v.number(),
	pendingCount: v.number(),
	declinedCount: v.number(),
	complete: v.boolean()
});

export const readiness = v.object({
	expectation: v.object({
		stateRevision: v.number(),
		documentId: v.id('contractDocuments'),
		documentRevision: v.number()
	}),
	blockers: v.array(
		v.object({ changeId: v.id('contractChanges'), kind: changeKind, reason: v.string() })
	),
	blockerCount: v.number(),
	pagination: nativePageMetadata,
	ready: v.boolean(),
	workBlock: v.union(v.null(), v.literal('association-required'), v.literal('deal-unavailable'))
});

/** Exact original receipt bytes shared by authority/email writers and their result waiters. */
export function reviewOperationInputs(input: {
	kind: 'change-decision' | 'proposal-support' | 'approval-request' | 'review-completion';
	args: Value;
}) {
	return JSON.stringify({ kind: input.kind, args: convexToJson(input.args) });
}
