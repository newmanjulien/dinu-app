import { v } from 'convex/values';
import { nativeStage } from './nativeStageValidators';
import {
	buyerProposalSource,
	changeActor,
	decisionAction,
	playbookSource
} from '../lib/contract/changes';
export { changeKind, changeStatus } from '../lib/contract/changes';

const change = v.object({
	stage: v.optional(nativeStage),
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	key: v.string(),
	operationId: v.string(),
	// Stable server operation identity used by immutable document lineage/dependencies.
	patchKey: v.string(),
	actor: changeActor,
	createdAt: v.number(),
	predecessorId: v.optional(v.id('contractChanges')),
	policy: v.union(v.literal('none'), v.literal('required')),
	chunks: v.number(),
	dataBytes: v.number()
});
export const storedContractChange = v.union(
	change.extend({ kind: v.literal('playbook'), source: playbookSource }),
	change.extend({
		kind: v.literal('buyer-link'),
		policy: v.literal('required'),
		source: buyerProposalSource
	})
);
/** Pending admission belongs to one activation, never to a separate head field. */
export const pendingChangeReview = v.object({
	kind: v.literal('pending'),
	admissionRevision: v.number()
});
export const decidedChangeReview = v.object({
	kind: v.literal('decided'),
	decisionId: v.id('contractChangeDecisions')
});
export const currentChangeReview = v.union(pendingChangeReview, decidedChangeReview);
const playbookBundle = v.object({
	changeId: v.id('contractChanges'),
	optionId: v.union(v.string(), v.null())
});
export const currentPlaybookBundle = v.union(
	playbookBundle.extend({ policy: v.literal('none') }),
	playbookBundle.extend({ policy: v.literal('required'), review: currentChangeReview })
);
export const appliedPlaybookBundle = v.union(
	playbookBundle.extend({ policy: v.literal('none') }),
	playbookBundle.extend({
		policy: v.literal('required'),
		decisionId: v.id('contractChangeDecisions')
	})
);
export const currentBuyerLinkBundle = v.object({
	changeId: v.id('contractChanges'),
	review: currentChangeReview
});
export const appliedBuyerLinkBundle = v.object({
	changeId: v.id('contractChanges'),
	decisionId: v.id('contractChangeDecisions')
});
const head = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	key: v.string()
});
/** Each variant owns all references and its own compact indexed projection. */
export const storedContractChangeHead = v.union(
	head.extend({
		kind: v.literal('playbook'),
		current: v.union(currentPlaybookBundle, v.null()),
		applied: v.union(appliedPlaybookBundle, v.null()),
		activePlaybook: v.boolean()
	}),
	head.extend({
		kind: v.literal('buyer-link'),
		current: v.union(currentBuyerLinkBundle, v.null()),
		applied: v.union(appliedBuyerLinkBundle, v.null())
	})
);
export const storedContractChangeDecision = v.object({
	stage: v.optional(nativeStage),
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	changeId: v.id('contractChanges'),
	actor: changeActor,
	operationId: v.string(),
	previousDecisionId: v.optional(v.id('contractChangeDecisions')),
	action: decisionAction,
	status: v.union(v.literal('approved'), v.literal('rejected')),
	decidedAt: v.number()
});
export const storedChangeContent = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	changeId: v.id('contractChanges'),
	order: v.number(),
	data: v.string()
});
