import { ConvexError, v, type Infer } from 'convex/values';
import { approvalState } from '../lib/contract/applications';

/** One plain mailbox, with the same identity at storage and provider boundaries. */
export function emailAddress(input: string) {
	const email = input.trim().toLowerCase();
	const [local, domain, extra] = email.split('@');
	if (
		email.length > 254 ||
		!local ||
		local.length > 64 ||
		!domain ||
		extra !== undefined ||
		!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local) ||
		!domain.includes('.') ||
		domain
			.split('.')
			.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
	)
		throw new ConvexError('Enter a valid email address.');
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
export const emailSelection = v.object({
	itemId: v.id('playbookItems'),
	concessionId: v.string(),
	concessionPosition: v.optional(v.number()),
	approval: v.optional(approvalState)
});
export type EmailSelection = Infer<typeof emailSelection>;
export const approvalEmailEvent = v.object({
	kind: v.literal('approval'),
	contractId: v.id('savedContracts'),
	requestId: v.string(),
	buyerCompanyName: v.string(),
	templateVersionId: v.id('templateVersions'),
	recipientEmail: v.string()
});
export const decisionEmailEvent = v.object({
	kind: v.literal('decision'),
	contractId: v.id('savedContracts'),
	reviewGeneration: v.number(),
	reviewerId: v.id('profiles'),
	buyerCompanyName: v.string(),
	templateVersionId: v.id('templateVersions')
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
