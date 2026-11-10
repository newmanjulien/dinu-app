import { v } from 'convex/values';

export const hubspotDestination = v.object({
	connectionId: v.id('hubspotConnections'),
	accountId: v.string(),
	dealId: v.string(),
	generation: v.number()
});
export const hubspotLink = hubspotDestination.extend({
	availability: v.union(v.literal('available'), v.literal('unavailable'))
});
export const hubspotKind = v.union(
	v.literal('created'),
	v.literal('applied'),
	v.literal('requested'),
	v.literal('approved'),
	v.literal('declined'),
	v.literal('downloaded')
);
export const hubspotConnection = v.object({
	companyId: v.id('company'),
	accountId: v.string(),
	generation: v.number(),
	accessToken: v.string(),
	refreshToken: v.string(),
	expiresAt: v.number(),
	scopes: v.array(v.string()),
	installerId: v.id('profiles'),
	installedAt: v.number(),
	status: v.union(v.literal('connected'), v.literal('reconnect'), v.literal('retiring')),
	refreshClaim: v.optional(v.string()),
	refreshUntil: v.optional(v.number())
});
export const hubspotOAuthState = v.object({
	companyId: v.id('company'),
	membershipId: v.id('memberships'),
	profileId: v.id('profiles'),
	hash: v.string(),
	purpose: v.optional(v.union(v.literal('base'), v.literal('quotes'))),
	quoteEpoch: v.optional(v.number()),
	expectedConnectionId: v.optional(v.id('hubspotConnections')),
	expectedAccountId: v.optional(v.string()),
	generation: v.number(),
	lifecycleVersion: v.optional(v.number()),
	expiresAt: v.number(),
	claimed: v.boolean()
});
export const hubspotEvent = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	key: v.string(),
	kind: hubspotKind,
	destination: hubspotDestination,
	title: v.string(),
	actor: v.object({ name: v.string(), email: v.string() }),
	occurredAt: v.number(),
	detail: v.string(),
	attemptId: v.optional(v.id('hubspotExports')),
	status: v.union(
		v.literal('pending'),
		v.literal('working'),
		v.literal('blocked'),
		v.literal('paused'),
		v.literal('uncertain'),
		v.literal('attention'),
		v.literal('retired'),
		v.literal('sent')
	),
	dueAt: v.number(),
	tries: v.number(),
	claim: v.optional(v.string()),
	leaseUntil: v.optional(v.number()),
	dispatch: v.optional(v.union(v.literal('file'), v.literal('note'))),
	dispatchedAt: v.optional(v.number()),
	dispatchId: v.optional(v.string()),
	operatorObservation: v.optional(v.boolean()),
	observation: v.optional(
		v.object({
			dispatchId: v.string(),
			kind: v.union(v.literal('note'), v.literal('file')),
			pass: v.string(),
			page: v.number(),
			after: v.optional(v.string()),
			next: v.optional(v.string()),
			ids: v.array(v.string()),
			position: v.number(),
			unresolved: v.number()
		})
	),
	fileId: v.optional(v.string()),
	noteId: v.optional(v.string()),
	diagnostic: v.optional(v.string()),
	workId: v.optional(v.string()),
	execution: v.optional(v.string())
});

export const hubspotRemovalOutcome = v.union(
	v.literal('pending'),
	v.literal('dispatched'),
	v.literal('confirmed'),
	v.literal('shared'),
	v.literal('attention'),
	v.literal('unknown')
);
export const hubspotRemoval = v.object({
	companyId: v.id('company'),
	connectionId: v.id('hubspotConnections'),
	accountId: v.string(),
	actorId: v.optional(v.id('profiles')),
	source: v.union(v.literal('workspace'), v.literal('hubspot')),
	createdAt: v.number(),
	providerId: v.id('hubspotAccountRemovals'),
	done: v.boolean(),
	dueAt: v.number(),
	phase: v.union(
		v.literal('quotes'),
		v.literal('events'),
		v.literal('exports'),
		v.literal('provider')
	),
	cursor: v.union(v.string(), v.null()),
	finishedAt: v.optional(v.number())
});
// External destructive authority outlives tenant history. Never store credentials or tenant content.
export const hubspotAccountRemoval = v.object({
	accountId: v.string(),
	removalId: v.optional(v.id('hubspotRemovals')),
	createdAt: v.number(),
	provider: hubspotRemovalOutcome,
	blocking: v.boolean(),
	detached: v.boolean(),
	dueAt: v.optional(v.number()),
	dispatchedAt: v.optional(v.number()),
	deleteStartedAt: v.optional(v.number()),
	settledAt: v.optional(v.number()),
	diagnostic: v.optional(v.string())
});
export const hubspotReceipt = v.object({
	companyId: v.id('company'),
	key: v.string(),
	inputs: v.string(),
	chunked: v.optional(v.boolean()),
	result: v.string()
});
export const hubspotExport = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	membershipId: v.id('memberships'),
	profileId: v.id('profiles'),
	key: v.string(),
	inputs: v.string(),
	destination: v.optional(hubspotDestination),
	title: v.string(),
	actor: v.object({ name: v.string(), email: v.string() }),
	templateVersionId: v.id('templateVersions'),
	editRevision: v.number(),
	reviewGeneration: v.number(),
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
	acknowledgedOn: v.optional(v.number()),
	attachmentUntil: v.optional(v.number()),
	remoteFileId: v.optional(v.string()),
	// Only tuple-v1 chunks are written; deployment inventory contained no legacy attempts.
	provenance: v.literal('tuple-v1')
	// Content lives in immutable template versions; the bounded selection is chunked separately.
});
export const hubspotExportChunk = v.object({
	companyId: v.id('company'),
	attemptId: v.id('hubspotExports'),
	order: v.number(),
	data: v.string()
});
