import { v } from 'convex/values';

export const contractCleanupPhase = v.union(
	v.literal('decisions'),
	v.literal('deliveries'),
	v.literal('buyerLinks'),
	v.literal('buyerActivity'),
	v.literal('buyerQuotas'),
	v.literal('discussions'),
	v.literal('hubspotQuotes'),
	v.literal('waitingDocuments'),
	v.literal('documents'),
	v.literal('documentChunks')
);
