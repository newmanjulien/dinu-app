import { ConvexError, v, type Infer } from 'convex/values';
import { normalizedEmailAddress } from '../lib/email-address';

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

export const approvalEmailEvent = v.object({
	kind: v.literal('approval'),
	contractId: v.id('savedContracts'),
	generation: v.number(),
	title: v.string(),
	pendingCount: v.number(),
	reviewedCount: v.number(),
	notRequiredCount: v.number()
});

export const decisionEmailEvent = v.object({
	kind: v.literal('decision'),
	contractId: v.id('savedContracts'),
	generation: v.number(),
	title: v.string(),
	reviewerId: v.id('profiles'),
	approvedCount: v.number(),
	rejectedCount: v.number()
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
	state: emailState
};

export const emailDelivery = v.union(
	v.object({
		...deliveryFields,
		event: v.union(approvalEmailEvent, decisionEmailEvent),
		contractId: v.id('savedContracts'),
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
