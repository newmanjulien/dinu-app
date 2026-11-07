import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** Included only by the explicitly prepared transition schema, never the normal schema. */
export const legacyTables = {
	creationReceipts: defineTable({
		companyId: v.id('company'),
		operationId: v.string(),
		itemId: v.id('playbookItems')
	})
		.index('by_operationId', ['operationId'])
		.index('by_companyId', ['companyId']),
	emailSnapshots: defineTable({
		companyId: v.id('company'),
		deliveryId: v.id('emailDeliveries'),
		order: v.number(),
		selections: v.array(v.any())
	})
		.index('by_deliveryId_and_order', ['deliveryId', 'order'])
		.index('by_companyId', ['companyId']),
	readabilityProgress: defineTable({
		companyId: v.id('company'),
		versionId: v.id('templateVersions'),
		identity: v.string(),
		nextItem: v.number(),
		jsonBytes: v.number(),
		readBytes: v.number()
	})
		.index('by_versionId', ['versionId'])
		.index('by_companyId', ['companyId'])
};
