import { v } from 'convex/values';

export const contractCleanupPhase = v.union(v.literal('decisions'), v.literal('deliveries'));
