import { ConvexError, v, type Infer } from 'convex/values';
import { reviewStatus } from './contractValidators';

/** One plain mailbox, with the same identity at storage and SMTP boundaries. */
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

export const emailOutcome = v.object({
	status: v.union(
		v.literal('sent'),
		v.literal('partial'),
		v.literal('failed'),
		v.literal('uncertain'),
		v.literal('skipped')
	),
	error: v.optional(v.string()),
	messageId: v.optional(v.string()),
	recipientAccepted: v.optional(v.boolean()),
	rejected: v.optional(v.array(v.string())),
	// Only failures proven safe to retry may set this flag.
	retryable: v.optional(v.boolean())
});
export type EmailOutcome = Infer<typeof emailOutcome>;
export const emailAttempt = v.object({ id: v.id('emailDeliveries'), attempt: v.number() });
export const emailRecipients = v.object({ recipientEmail: v.string(), cc: v.array(v.string()) });
export const emailSelection = v.object({
	itemId: v.id('playbookItems'),
	concessionId: v.string(),
	concessionPosition: v.optional(v.number()),
	lifecycle: v.optional(v.string()),
	reviewStatus: v.optional(reviewStatus),
	reviewerId: v.optional(v.id('profiles')),
	reviewerName: v.optional(v.string())
});
export type EmailSelection = Infer<typeof emailSelection>;
export const emailDelivery = emailOutcome.omit('status', 'retryable').extend({
	companyId: v.id('company'),
	event: v.union(
		v.object({
			kind: v.literal('approval'),
			contractId: v.id('savedContracts'),
			requestId: v.string(),
			companyName: v.string(),
			templateVersionId: v.id('templateVersions')
		}),
		v.object({
			kind: v.literal('decision'),
			contractId: v.id('savedContracts'),
			reviewGeneration: v.number(),
			companyName: v.string(),
			templateVersionId: v.id('templateVersions')
		}),
		v.object({
			kind: v.literal('invitation'),
			invitationId: v.id('companyInvitations'),
			generation: v.number()
		})
	),
	contractId: v.optional(v.id('savedContracts')),
	status: v.union(v.literal('sending'), emailOutcome.fields.status),
	attempt: v.number(),
	dispatchStarted: v.boolean(),
	retryable: v.boolean(),
	sendJobId: v.optional(v.id('_scheduled_functions')),
	recoveryJobId: v.optional(v.id('_scheduled_functions')),
	inlineDeadline: v.optional(v.number()),
	recipientEmail: v.optional(v.string()),
	cc: v.optional(v.array(v.string())),
	completedAt: v.optional(v.number())
});
