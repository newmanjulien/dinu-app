import { v } from 'convex/values';

export const deviceCategory = v.union(
	v.literal('computer'),
	v.literal('phone'),
	v.literal('tablet')
);
export const activityOpening = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	linkId: v.id('buyerLinks'),
	browserId: v.string(),
	// Verified same-company identity; external visitors remain browser-scoped.
	profileId: v.optional(v.id('profiles')),
	openingId: v.string(),
	// Reloads/tabs retain delivery IDs while sharing a single visible visit.
	visitId: v.optional(v.id('buyerActivityOpenings')),
	lastActivityAt: v.optional(v.number()),
	acceptedAt: v.number(),
	expiresAt: v.number(),
	visitorNumber: v.number(),
	returning: v.boolean(),
	clauseCount: v.number(),
	eventCount: v.number(),
	lastClauseAt: v.optional(v.number()),
	device: v.optional(deviceCategory),
	city: v.optional(v.string())
});
const openingChild = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	openingId: v.id('buyerActivityOpenings'),
	expiresAt: v.number()
});
export const activityReceipt = openingChild.extend({
	eventId: v.string(),
	sequence: v.number(),
	itemId: v.string()
});

export const quotaName = v.union(
	v.literal('activityBrowser'),
	v.literal('activityLink'),
	v.literal('activityCompany')
);
const quotaOwner = v.object({
	key: v.string(),
	companyId: v.id('company'),
	expiresAt: v.number()
});
export const activityQuotaKey = quotaOwner.extend({
	name: quotaName,
	contractId: v.optional(v.id('savedContracts')),
	linkId: v.optional(v.id('buyerLinks'))
});
export const discussionQuotaKey = quotaOwner.extend({
	name: v.union(v.literal('discussionActor'), v.literal('discussionCompany')),
	contractId: v.optional(v.id('savedContracts'))
});
