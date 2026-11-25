import { v } from 'convex/values';

export const wordExportRequest = v.object({
	membershipId: v.id('memberships'),
	id: v.id('savedContracts'),
	operationId: v.string(),
	expectedStateRevision: v.number()
});

export const storedWordExport = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	templateVersionId: v.id('templateVersions'),
	title: v.string(),
	actor: v.object({ name: v.string(), email: v.string() }),
	membershipId: v.id('memberships'),
	profileId: v.id('profiles'),
	key: v.string(),
	createdAt: v.number(),
	expiresAt: v.optional(v.number()),
	fileId: v.optional(v.id('_storage')),
	filename: v.string(),
	sha256: v.string(),
	size: v.number()
});
