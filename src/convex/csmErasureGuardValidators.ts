import { v } from 'convex/values';
import { providerScope } from './csmBookingValidators';
export const guardTerminal = v.object({
	sendJobId: v.id('_scheduled_functions'),
	kind: v.string(),
	observedAt: v.number()
});
export const guardDisposition = v.union(
	v.literal('unresolved'),
	v.literal('notCreated'),
	v.literal('externalBookingExists')
);
export const storedErasureGuard = v.object({
	companyId: v.id('company'),
	identity: v.string(),
	dispatchId: v.optional(v.string()),
	scope: v.optional(providerScope),
	generation: v.number(),
	phase: v.union(v.literal('submitting'), v.literal('unknown'), v.literal('legacyUncertain')),
	sendJobId: v.optional(v.id('_scheduled_functions')),
	terminal: v.optional(guardTerminal),
	disposition: guardDisposition,
	blocking: v.boolean(),
	reviewReason: v.string(),
	observeAt: v.optional(v.number()),
	observationRounds: v.number(),
	review: v.optional(
		v.object({ generation: v.number(), terminal: guardTerminal, begunAt: v.number() })
	),
	resolution: v.optional(
		v.object({
			operator: v.string(),
			evidence: v.string(),
			reason: v.string(),
			at: v.number(),
			investigatedAt: v.number()
		})
	)
});
