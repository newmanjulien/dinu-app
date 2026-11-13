import { ConvexError, v, type Infer } from 'convex/values';

import { normalizedEmailAddress } from '../lib/email-address';
import {
	approvalContext,
	buyerProposalSource,
	changeActor,
	playbookSource
} from '../lib/contract/changes';
import { preparationActor } from './discussionPreparationValidators';

export function emailAddress(input: string) {
	const email = normalizedEmailAddress(input);
	if (email === null) throw new ConvexError('Enter a valid email address.');
	return email;
}

const outcomeDetails = v.object({ error: v.optional(v.string()) });
export const emailOutcome = v.union(
	outcomeDetails.extend({
		status: v.union(v.literal('sent'), v.literal('uncertain'), v.literal('skipped'))
	}),
	outcomeDetails.extend({ status: v.literal('failed'), retryable: v.optional(v.boolean()) })
);
export type EmailOutcome = Infer<typeof emailOutcome>;
export const emailAttempt = v.object({ id: v.id('emailDeliveries'), attempt: v.number() });
export const emailRecipients = v.object({ recipientEmail: v.string(), cc: v.array(v.string()) });
export const nativeEmailEntry = v.object({
	changeId: v.id('contractChanges'),
	decisionId: v.union(v.id('contractChangeDecisions'), v.null()),
	key: v.string(),
	status: v.union(v.literal('pending'), v.literal('approved'), v.literal('rejected')),
	pendingAdmissionRevision: v.union(v.number(), v.null()),
	actor: changeActor,
	source: v.union(
		v.object({ kind: v.literal('playbook'), value: playbookSource }),
		v.object({ kind: v.literal('buyer-proposal'), value: buyerProposalSource })
	),
	decision: v.union(v.null(), v.object({ actor: changeActor, decidedAt: v.number() }))
});
export type NativeEmailEntry = Infer<typeof nativeEmailEntry>;
export const emailCounts = v.object({
	pendingCount: v.number(),
	reviewedCount: v.number(),
	notRequiredCount: v.number(),
	approvedCount: v.number(),
	rejectedCount: v.number()
});
export type EmailCounts = Infer<typeof emailCounts>;
export const emailFilterFence = v.object({
	stateRevision: v.number(),
	supportGeneration: v.number(),
	storageGeneration: v.number()
});
export const emailFilterManifest = v.object({
	fence: emailFilterFence,
	order: v.number(),
	count: v.number(),
	bytes: v.number(),
	hash: v.string(),
	filteredHash: v.string(),
	counts: emailCounts
});
export const emailSnapshot = v.object({
	state: v.union(v.literal('staging'), v.literal('complete')),
	actor: preparationActor,
	operationId: v.string(),
	ownerKey: v.string(),
	receiptId: v.optional(v.id('operationReceipts')),
	generation: v.number(),
	contextIdentity: v.string(),
	cutoff: v.number(),
	sourceDocumentId: v.id('contractDocuments'),
	documentRevision: v.number(),
	stateRevision: v.number(),
	supportGeneration: v.number(),
	storageGeneration: v.number(),
	latestRequestId: v.union(v.string(), v.null()),
	count: v.number(),
	chunks: v.number(),
	bytes: v.number(),
	hash: v.string()
});
const nativeReviewEvent = {
	context: approvalContext,
	identity: v.string(),
	buyerToken: v.optional(v.string()),
	contractId: v.id('savedContracts'),
	title: v.string(),
	templateVersionId: v.id('templateVersions')
};
export const approvalEmailEvent = v.object({
	...nativeReviewEvent,
	kind: v.literal('approval'),
	requestId: v.string(),
	recipientEmail: v.string()
});
export const decisionEmailEvent = v.object({
	...nativeReviewEvent,
	kind: v.literal('decision'),
	reviewerId: v.id('profiles')
});
export const invitationEmailEvent = v.object({
	kind: v.literal('invitation'),
	invitationId: v.id('companyInvitations'),
	generation: v.number(),
	recipientEmail: v.string()
});
export const emailEvent = v.union(approvalEmailEvent, decisionEmailEvent, invitationEmailEvent);
export type EmailEvent = Infer<typeof emailEvent>;

const claimedDispatch = emailRecipients.extend({ kind: v.literal('claimed') });
const dispatching = emailRecipients.extend({ kind: v.literal('dispatching') });
const terminalState = outcomeDetails.extend({
	completedAt: v.number(),
	dispatch: v.optional(v.union(claimedDispatch, dispatching))
});
export const emailState = v.union(
	v.object({
		kind: v.literal('sending'),
		dispatch: v.union(v.object({ kind: v.literal('pending') }), claimedDispatch, dispatching)
	}),
	terminalState.extend({
		kind: v.union(v.literal('sent'), v.literal('skipped'))
	}),
	terminalState.extend({ kind: v.literal('failed'), retryable: v.boolean() }),
	// Eligibility permits an explicit approval retry after its cooldown. It does
	// not prove non-delivery and must never authorize automatic replay.
	terminalState.extend({ kind: v.literal('uncertain'), retryEligible: v.boolean() })
);
const scheduledExecution = v.object({
	kind: v.literal('scheduled'),
	sendJobId: v.optional(v.id('_scheduled_functions')),
	recoveryJobId: v.optional(v.id('_scheduled_functions'))
});
const deliveryFields = {
	companyId: v.id('company'),
	attempt: v.number(),
	state: emailState,
	filter: v.optional(emailFilterManifest),
	// A retired delivery owns its remaining chunks until bounded disposal finishes.
	disposal: v.optional(
		v.object({ generation: v.number(), jobId: v.optional(v.id('_scheduled_functions')) })
	)
};
export const emailDelivery = v.union(
	v.object({
		...deliveryFields,
		event: v.union(approvalEmailEvent, decisionEmailEvent),
		contractId: v.id('savedContracts'),
		snapshot: emailSnapshot,
		execution: scheduledExecution
	}),
	v.object({
		...deliveryFields,
		event: invitationEmailEvent,
		execution: v.object({
			kind: v.literal('inline'),
			deadline: v.number(),
			recoveryJobId: v.optional(v.id('_scheduled_functions'))
		})
	})
);
