// Only included by the temporary maintenance schema. Removed after a completed cutover.
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const terminologyTables = {
	baselines: defineTable(v.any()),
	baselineChunks: defineTable(v.any()),
	baselineAuthoring: defineTable(v.any()),
	baselineValidationChunks: defineTable(v.any()),
	terminologyMappings: defineTable({
		legacyId: v.string(),
		newId: v.string(),
		companyId: v.id('company'),
		oldReadBytes: v.optional(v.number()),
		readBytes: v.optional(v.number())
	}).index('by_legacyId', ['legacyId']),
	terminologyMigrationState: defineTable({
		name: v.literal('template-terminology'),
		phase: v.number(),
		cursor: v.union(v.string(), v.null())
	}).index('by_name', ['name'])
};
