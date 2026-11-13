import { v } from 'convex/values';

/** Physical attempt IDs remain the browser acknowledgment identity. Immutable request
 * evidence belongs solely to the original server-owned reservation receipt. */
export const exportAttempt = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	reservationReceiptId: v.id('operationReceipts'),
	documentId: v.id('contractDocuments'),
	membershipId: v.id('memberships'),
	profileId: v.id('profiles'),
	key: v.string(),
	inputs: v.string(),
	createdAt: v.number(),
	expiresAt: v.number(),
	state: v.union(v.literal('preparing'), v.literal('ready'), v.literal('expired')),
	claim: v.string(),
	fileId: v.optional(v.id('_storage')),
	filename: v.string(),
	sha256: v.optional(v.string()),
	size: v.optional(v.number()),
	releasedAt: v.optional(v.number()),
	acknowledgedAt: v.optional(v.number()),
	acknowledgedOn: v.optional(v.number())
});
export const storedExportAttempt = exportAttempt;
