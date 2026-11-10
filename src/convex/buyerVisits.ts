import { v } from 'convex/values';
import { internalMutation } from './_generated/server';

/** Fence legacy scheduled projection continuations after the raw writer is retired. */
export const project = internalMutation({
	args: { contractId: v.id('savedContracts'), visitorNumber: v.number() },
	returns: v.null(),
	handler: async () => null
});
