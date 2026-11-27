import { v } from 'convex/values';

export const contractCleanupPhase = v.union(
	v.literal('deliveries'),
	v.literal('buyerLinks'),
	v.literal('buyerActivity'),
	v.literal('buyerQuotas'),
	v.literal('discussions'),
	v.literal('exports'),
	v.literal('hubspotQuotes')
);
