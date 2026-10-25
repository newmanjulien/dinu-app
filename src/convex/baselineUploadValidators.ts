import { v } from 'convex/values';
export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const issue = v.object({
	severity: v.union(v.literal('warning'), v.literal('error')),
	location: v.string(),
	message: v.string(),
	context: v.optional(v.string())
});
export const preparation = v.object({
	preparedBaselineId: v.union(v.id('baselines'), v.null()),
	blockCount: v.number(),
	issues: v.array(issue)
});
