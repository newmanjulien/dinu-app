import { v } from 'convex/values';

export const activityKind = v.union(
	v.literal('internal'),
	v.literal('external'),
	v.literal('unknown')
);
export const deviceCategory = v.union(
	v.literal('computer'),
	v.literal('phone'),
	v.literal('tablet')
);
export const buyerEvent = v.union(
	v.object({ type: v.literal('link_opened') }),
	v.object({ type: v.literal('clause_opened'), itemId: v.string() })
);
export const opening = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	linkId: v.id('buyerLinks'),
	openingId: v.string(),
	// Historical rows without these fields are link-open events; openingId is the event ID.
	event: v.optional(buyerEvent),
	visitId: v.optional(v.string()),
	sequence: v.optional(v.number()),
	// Delivery/page IDs above are independent of the server's inactivity-based visit.
	activityVisitId: v.optional(v.id('buyerVisits')),
	projected: v.optional(v.literal(true)),
	clauseId: v.optional(v.string()),
	at: v.number(),
	kind: activityKind,
	profileId: v.optional(v.id('profiles')),
	visitorKey: v.optional(v.string()),
	visitorNumber: v.optional(v.number()),
	// Legacy feed flag retained only for historical document compatibility.
	identified: v.optional(v.literal(true)),
	device: v.optional(deviceCategory),
	city: v.optional(v.string()),
	// Retired analytics fields remain accepted until removeActivityAnalytics has run.
	latestForVisitor: v.optional(v.boolean()),
	memberName: v.optional(v.string()),
	browserNumber: v.optional(v.number()),
	returning: v.optional(v.boolean())
});

export const activityVisit = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	visitorNumber: v.number(),
	startedAt: v.number(),
	lastAt: v.number(),
	returning: v.boolean(),
	clauseCount: v.number(),
	lastClauseAt: v.optional(v.number()),
	kind: activityKind,
	profileId: v.optional(v.id('profiles')),
	device: v.optional(deviceCategory),
	city: v.optional(v.string())
});

export const activityOpening = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	linkId: v.id('buyerLinks'),
	browserId: v.string(),
	openingId: v.string(),
	acceptedAt: v.number(),
	expiresAt: v.number(),
	visitorNumber: v.number(),
	returning: v.boolean(),
	clauseCount: v.number(),
	eventCount: v.number(),
	lastClauseAt: v.optional(v.number()),
	device: v.optional(deviceCategory)
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
	itemId: v.string(),
	// Historical timestamp; opening.acceptedAt and lastClauseAt own display times.
	acceptedAt: v.optional(v.number())
});
export const distinctClause = openingChild.extend({ itemId: v.string() });

export const quotaName = v.union(
	// Legacy component buckets remain addressable only for retirement.
	v.literal('buyerBrowser'),
	v.literal('buyerCompany'),
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
