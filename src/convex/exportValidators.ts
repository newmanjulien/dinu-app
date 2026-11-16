import { v } from 'convex/values';

/** Physical attempt IDs remain the browser acknowledgment identity. Immutable request
 * evidence belongs solely to the durable output. */
export const exportAttempt = v.object({
	format: v.literal('full'),
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	outputId: v.id('contractOutputs'),
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
	deletingFileId: v.optional(v.id('_storage')),
	filename: v.string(),
	sha256: v.optional(v.string()),
	size: v.optional(v.number()),
	releasedAt: v.optional(v.number()),
	acknowledgedAt: v.optional(v.number()),
	acknowledgedOn: v.optional(v.number())
});
export const compactExportAttempt = exportAttempt
	.pick(
		'companyId',
		'contractId',
		'outputId',
		'membershipId',
		'profileId',
		'createdAt',
		'filename',
		'sha256',
		'size',
		'releasedAt',
		'acknowledgedAt',
		'acknowledgedOn'
	)
	.extend({ format: v.literal('compact'), state: v.literal('expired') });
export const storedExportAttempt = v.union(exportAttempt, compactExportAttempt);
