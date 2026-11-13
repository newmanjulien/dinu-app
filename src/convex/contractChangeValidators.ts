import { v } from 'convex/values';
import { nativeStage } from './nativeStageValidators';
import {
	buyerProposalSource,
	changeActor,
	changeKind,
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
	change.extend({ kind: v.literal('buyer-proposal'), source: buyerProposalSource })
);
/** Only exact current/applied references are mutable. Status follows the effective decision. */
export const storedContractChangeHead = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	kind: changeKind,
	key: v.string(),
	activePlaybook: v.boolean(),
	playbook: v.optional(
		v.object({
			current: v.union(
				v.null(),
				v.object({
					optionId: v.union(v.string(), v.null()),
					policy: v.union(v.literal('none'), v.literal('required'))
				})
			),
			applied: v.union(
				v.null(),
				v.object({
					optionId: v.union(v.string(), v.null()),
					policy: v.union(v.literal('none'), v.literal('required'))
				})
			)
		})
	),
	currentChangeId: v.optional(v.id('contractChanges')),
	appliedChangeId: v.optional(v.id('contractChanges')),
	currentDecisionId: v.optional(v.id('contractChangeDecisions')),
	appliedDecisionId: v.optional(v.id('contractChangeDecisions')),
	// Renewed on each activation, including a rejected support becoming pending again.
	pendingAdmissionRevision: v.optional(v.number())
});
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
