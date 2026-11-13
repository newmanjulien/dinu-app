import { v } from 'convex/values';
import { providerScope } from './csmBookingValidators';
export const meetingState = v.union(
	v.literal('pending'),
	v.literal('running'),
	v.literal('unknown'),
	v.literal('ready'),
	v.literal('needs-attention'),
	v.literal('stopped')
);
export const storedMeetingPreparation = v.object({
	companyId: v.id('company'),
	profileId: v.id('profiles'),
	attemptId: v.id('csmBookingAttempts'),
	uid: v.string(),
	start: v.string(),
	end: v.string(),
	scope: providerScope,
	reference: v.string(),
	attendeeHash: v.string(),
	calendarHash: v.optional(v.string()),
	state: meetingState,
	mode: v.optional(v.literal('successor-only')),
	lastHintedSuccessorUid: v.optional(v.string()),
	revision: v.number(),
	passes: v.number(),
	expiresAt: v.number(),
	writeReserved: v.boolean(),
	refreshRequested: v.optional(v.boolean()),
	updatedAt: v.number(),
	meetingUrl: v.optional(v.string()),
	reason: v.optional(v.string()),
	jobId: v.optional(v.id('_scheduled_functions')),
	watchdogId: v.optional(v.id('_scheduled_functions')),
	leaseUntil: v.optional(v.number()),
	dueAt: v.optional(v.number()),
	repair: v.optional(
		v.object({ operator: v.string(), evidence: v.string(), reason: v.string(), at: v.number() })
	)
});
