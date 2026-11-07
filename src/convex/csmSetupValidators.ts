import { v } from 'convex/values';

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
export const storedSetupAppointment = v.object({
	companyId: v.id('company'),
	profileId: v.id('profiles'),
	membershipId: v.optional(v.id('memberships')),
	attemptId: v.optional(v.id('csmBookingAttempts')),
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
	providerUpdatedAt: v.optional(v.number()),
	selection: setupSelection,
	sortAt: v.number(),
	observedAt: v.optional(v.number()),
	freshUntil: v.optional(v.number()),
	generation: v.number(),
	lease: v.number(),
	leaseUntil: v.optional(v.number()),
	dirty: v.boolean(),
	failures: v.number(),
	issue: v.optional(setupSyncIssue),
	repairAt: v.optional(v.number()),
	// Bounded unresolved locators; overflow cannot be discharged by a subset proof.
	pendingSuccessors: v.optional(v.object({ uids: v.array(v.string()), overflow: v.boolean() })),
	// Read compatibility for rows written before pendingSuccessors.
	successorHint: v.optional(v.string()),
	refreshJobId: v.optional(v.id('_scheduled_functions')),
	deadlineJobId: v.optional(v.id('_scheduled_functions'))
});
export const setupNotice = v.union(
	v.null(),
	v.object({
		id: v.id('csmSetupAppointments'),
		currentUid: v.string(),
		state: v.union(v.literal('scheduled'), v.literal('cancelled'), v.literal('checking')),
		start: v.string(),
		end: v.string(),
		freshUntil: v.union(v.number(), v.null())
	})
);
