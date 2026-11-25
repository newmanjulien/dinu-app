import { v } from 'convex/values';

/** Flat idempotency fence for contract, approval, buyer-link, discussion, and HubSpot mutations. */
export const operationReceipt = v.object({
	companyId: v.id('company'),
	contractId: v.optional(v.id('savedContracts')),
	key: v.string(),
	inputs: v.string(),
	result: v.string(),
	expiresAt: v.number()
});
