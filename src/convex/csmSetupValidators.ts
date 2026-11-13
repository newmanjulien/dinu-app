import { v } from 'convex/values';
import { providerScope } from './csmBookingValidators';

export const setupSelection = v.union(
	v.literal('scheduled'),
	v.literal('cancelled'),
	v.literal('checking'),
	v.literal('hidden'),
	v.literal('superseded')
);
export const setupSyncIssue = v.union(
	v.literal('provider'),
	v.literal('chain'),
	v.literal('cap'),
	v.literal('conflict')
);
export const setupReviewSession = v.object({
	lease: v.number(),
	generation: v.number(),
	evidenceGeneration: v.number(),
	currentUid: v.string(),
	startedAt: v.number(),
	expiresAt: v.number(),
	cursor: v.union(v.string(), v.null()),
	inspected: v.number(),
	isDone: v.boolean()
});
export const setupReviewAttestation = v.object({
	operator: v.string(),
	evidence: v.string(),
	reason: v.string(),
	exhaustive: v.literal(true),
	originalAssociationConfirmed: v.literal(true),
	coversLostOverflow: v.literal(true)
});
/** A coherent, decisive fact. Refresh state must never change only part of this record. */
export const confirmedSetupBooking = v.object({
	status: v.union(v.literal('accepted'), v.literal('cancelled')),
	uid: v.string(),
	start: v.string(),
	end: v.string(),
	confirmedAt: v.number(),
	providerUpdatedAt: v.optional(v.number())
});
export const setupCallView = v.union(
	v.null(),
	v.object({
		state: v.union(v.literal('scheduled'), v.literal('cancelled')),
		start: v.string(),
		end: v.string()
	})
);
export const storedSetupAppointment = v.object({
	companyId: v.id('company'),
	profileId: v.id('profiles'),
	membershipId: v.optional(v.id('memberships')),
	attemptId: v.optional(v.id('csmBookingAttempts')),
	providerScope: v.optional(providerScope),
	attemptReference: v.optional(v.string()),
	legacyReference: v.optional(v.string()),
	// App replacements are independent Cal chains. These are never provider successor links.
	replacementAttemptId: v.optional(v.id('csmBookingAttempts')),
	superseded: v.optional(v.boolean()),
	erasedReplacementUncertain: v.optional(v.boolean()),
	source: v.union(v.literal('native'), v.literal('legacy')),
	anchorUid: v.string(),
	currentUid: v.string(),
	start: v.string(),
	end: v.string(),
	status: v.union(v.literal('accepted'), v.literal('cancelled'), v.literal('checking')),
	// Transitional marker for old deployments; remove after snapshot reconciliation.
	bookingConfirmation: v.optional(v.union(v.literal('accepted'), v.literal('cancelled'))),
	confirmedBooking: v.optional(confirmedSetupBooking),
	providerUpdatedAt: v.optional(v.number()),
	selection: setupSelection,
	sortAt: v.number(),
	observedAt: v.optional(v.number()),
	freshUntil: v.optional(v.number()),
	evidenceGeneration: v.optional(v.number()),
	generation: v.number(),
	lease: v.number(),
	leaseUntil: v.optional(v.number()),
	dirty: v.boolean(),
	failures: v.number(),
	issue: v.optional(setupSyncIssue),
	reviewReason: v.optional(v.string()),
	reviewSession: v.optional(setupReviewSession),
	reviewedResolution: v.optional(
		v.object({
			...setupReviewAttestation.fields,
			at: v.number(),
			generation: v.number(),
			evidenceGeneration: v.number(),
			inspected: v.number(),
			lease: v.number()
		})
	),
	maintenanceRetired: v.optional(v.literal('released')),
	repairAt: v.optional(v.number()),
	// Bounded unresolved locators; overflow cannot be discharged by a subset proof.
	pendingSuccessors: v.optional(v.object({ uids: v.array(v.string()), overflow: v.boolean() })),
	// Read compatibility for rows written before pendingSuccessors.
	successorHint: v.optional(v.string()),
	refreshJobId: v.optional(v.id('_scheduled_functions')),
	deadlineJobId: v.optional(v.id('_scheduled_functions'))
});
