import { v } from 'convex/values';
import { providerScope } from './csmBookingValidators';
export const evidenceEvent = v.union(
	v.literal('BOOKING_CREATED'),
	v.literal('BOOKING_REQUESTED'),
	v.literal('BOOKING_RESCHEDULED'),
	v.literal('BOOKING_CANCELLED'),
	v.literal('BOOKING_REJECTED'),
	v.literal('BOOKING_LOCATION_UPDATED'),
	v.literal('RECOVERY_HINT')
);
export const evidenceHint = v.object({
	uid: v.string(),
	event: evidenceEvent,
	scope: v.optional(providerScope),
	reference: v.optional(v.string()),
	historicalReference: v.optional(v.string()),
	previousUid: v.optional(v.string()),
	successorHint: v.optional(v.string()),
	occurrence: v.optional(v.string()),
	revision: v.optional(v.string())
});
export const ingressResult = v.union(
	v.object({ kind: v.literal('unrelated') }),
	v.object({ kind: v.literal('duplicate') }),
	v.object({ kind: v.literal('retained'), evidenceId: v.id('csmWebhookEvidence') }),
	v.object({ kind: v.literal('needsRetention') })
);
export const storedEvidence = v.object({
	identity: v.string(),
	// Opaque creation identity lets erased transport duplicates survive a live company guard.
	dispatchId: v.optional(v.string()),
	hint: v.optional(evidenceHint),
	state: v.union(
		v.literal('queued'),
		v.literal('claimed'),
		v.literal('retained'),
		v.literal('review'),
		v.literal('completed'),
		v.literal('erased')
	),
	companyId: v.optional(v.id('company')),
	profileId: v.optional(v.id('profiles')),
	attemptId: v.optional(v.id('csmBookingAttempts')),
	appointmentId: v.optional(v.id('csmSetupAppointments')),
	generation: v.number(),
	evidenceGeneration: v.optional(v.number()),
	lease: v.number(),
	leaseUntil: v.optional(v.number()),
	dueAt: v.optional(v.number()),
	failures: v.number(),
	reviewReason: v.optional(v.string()),
	completedAt: v.optional(v.number()),
	jobId: v.optional(v.id('_scheduled_functions'))
});
