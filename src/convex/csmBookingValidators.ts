import { v } from 'convex/values';

export const meetingPolicy = v.literal('google-meet-after-booking');
export const providerScope = v.object({ eventTypeId: v.number(), organizerId: v.number() });

export const bookingMode = v.union(v.literal('setup'), v.literal('support'));
export const setupReplacement = v.object({
	appointmentId: v.id('csmSetupAppointments'),
	currentUid: v.string()
});
export const bookingState = v.union(
	v.literal('queued'),
	v.literal('submitting'),
	v.literal('unknown'),
	v.literal('booked'),
	v.literal('failed')
);
export const bookingError = v.union(
	v.literal('unavailable'),
	v.literal('conflict'),
	v.literal('limit'),
	v.literal('access'),
	v.literal('cancelled'),
	v.literal('interrupted'),
	v.literal('uncertain')
);
export const providerBooking = v.object({
	uid: v.string(),
	start: v.string(),
	end: v.string(),
	status: v.union(
		v.literal('accepted'),
		v.literal('pending'),
		v.literal('cancelled'),
		v.literal('rejected')
	),
	fromUid: v.optional(v.string()),
	toUid: v.optional(v.string()),
	updatedAt: v.number()
});
export const confirmation = v.object({
	uid: v.string(),
	start: v.string(),
	end: v.string(),
	confirmedAt: v.number()
});
export const failureBasis = v.union(
	v.literal('queuedPreflight'),
	v.literal('queuedExpired'),
	v.literal('claimedPredispatch'),
	v.literal('providerRejection'),
	v.literal('providerTerminal'),
	v.literal('providerInvestigation')
);
/** Canceling a running action does not stop its execution. Historical tokens stay readable only. */
export function isSenderExecutionTerminal(kind: string | undefined) {
	return kind === 'success' || kind === 'failed';
}
export const terminalProof = v.object({
	attemptId: v.id('csmBookingAttempts'),
	sendJobId: v.id('_scheduled_functions'),
	kind: v.string(),
	observedAt: v.number()
});
export const bookingAck = v.object({
	attemptId: v.id('csmBookingAttempts'),
	operationId: v.string()
});
const operatorResolution = v.object({
	operator: v.string(),
	evidence: v.string(),
	reason: v.string(),
	at: v.number(),
	priorLineage: v.optional(v.array(providerBooking))
});
const attemptFields = v.object({
	meetingPolicy: v.optional(meetingPolicy),
	recoveryDue: v.optional(v.number()),
	recoveryGeneration: v.optional(v.number()),
	recoveryLease: v.optional(v.number()),
	recoveryLeaseUntil: v.optional(v.number()),
	recoveryJobId: v.optional(v.id('_scheduled_functions')),
	recoveryFailures: v.optional(v.number()),
	recoveryReview: v.optional(v.string()),
	recoverySeedUid: v.optional(v.string()),
	companyId: v.id('company'),
	profileId: v.id('profiles'),
	membershipId: v.id('memberships'),
	mode: bookingMode,
	replacement: v.optional(setupReplacement),
	operationId: v.string(),
	eventTypeId: v.optional(v.number()), // Historical decoder only.
	providerScope: v.optional(providerScope),
	attemptReference: v.optional(v.string()),
	dispatchId: v.optional(v.string()),
	requestedStart: v.string(),
	timeZone: v.string(),
	attendeeName: v.optional(v.string()),
	attendeeEmail: v.optional(v.string()),
	state: bookingState,
	error: v.optional(bookingError),
	failureBasis: v.optional(failureBasis),
	confirmation: v.optional(confirmation),
	revision: v.number(),
	updatedAt: v.number(),
	sendJobId: v.optional(v.id('_scheduled_functions')),
	watchdogJobId: v.optional(v.id('_scheduled_functions')),
	senderTerminal: v.optional(v.object({ kind: v.string(), observedAt: v.number() })),
	// Read-only compatibility locators, removed on resolution. New receipts never store a graph.
	lineage: v.optional(v.array(providerBooking)),
	providerUid: v.optional(v.string()),
	reviewRequired: v.optional(v.boolean()),
	operatorResolution: v.optional(operatorResolution)
});

// Old rows remain admissible while the bounded receipt conversion is rehearsed.
// New writers always choose format 2 and supply evidence for terminal states.
export const legacyCsmAttempt = attemptFields.extend({ format: v.optional(v.literal(1)) });
const canonicalAttempt = attemptFields.extend({ format: v.literal(2) });
export const canonicalCsmAttempt = v.union(
	canonicalAttempt.extend({
		state: v.union(v.literal('queued'), v.literal('submitting'), v.literal('unknown'))
	}),
	canonicalAttempt.extend({ state: v.literal('booked'), confirmation }),
	canonicalAttempt.extend({
		state: v.literal('failed'),
		error: bookingError,
		failureBasis: v.union(
			v.literal('queuedPreflight'),
			v.literal('queuedExpired'),
			v.literal('claimedPredispatch'),
			v.literal('providerRejection')
		)
	}),
	canonicalAttempt.extend({
		state: v.literal('failed'),
		error: bookingError,
		failureBasis: v.literal('providerTerminal'),
		providerUid: v.string(),
		senderTerminal: v.object({ kind: v.string(), observedAt: v.number() })
	}),
	canonicalAttempt.extend({
		state: v.literal('failed'),
		error: bookingError,
		failureBasis: v.literal('providerInvestigation'),
		senderTerminal: v.object({ kind: v.string(), observedAt: v.number() }),
		operatorResolution
	})
);
export const storedCsmAttempt = v.union(legacyCsmAttempt, ...canonicalCsmAttempt.members);
export const attemptView = v.object({
	id: v.id('csmBookingAttempts'),
	operationId: v.string(),
	mode: bookingMode,
	replacement: v.optional(setupReplacement),
	state: bookingState,
	requestedStart: v.string(),
	start: v.string(),
	timeZone: v.string(),
	error: v.union(bookingError, v.null())
});
export const availabilityResult = v.object({
	status: v.union(v.literal('ready'), v.literal('unavailable')),
	slots: v.array(v.object({ start: v.string(), end: v.string() })),
	duration: v.number(),
	lastDate: v.union(v.string(), v.null())
});
