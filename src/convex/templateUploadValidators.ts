import { v } from 'convex/values';
export const paragraphDecision = v.object({
	blockKey: v.string(),
	reason: v.string(),
	needsReview: v.boolean()
});
export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const issue = v.object({
	severity: v.union(v.literal('warning'), v.literal('error')),
	location: v.string(),
	message: v.string(),
	context: v.optional(v.string())
});
export const preparation = v.object({
	pendingTemplateSourceId: v.union(v.id('templateSources'), v.null()),
	blockCount: v.number(),
	issues: v.array(issue)
});

export const pendingTemplateMetadata = v.object({
	pendingTemplateSourceId: v.id('templateSources'),
	filename: v.string(),
	uploadedAt: v.number(),
	expiresAt: v.number(),
	issues: v.array(issue)
});
export const setupCalendarTarget = v.union(
	v.object({
		kind: v.literal('initial'),
		state: v.union(v.literal('ready'), v.literal('in-progress'), v.literal('uncertain'))
	}),
	v.object({
		kind: v.literal('replacement'),
		appointmentId: v.id('csmSetupAppointments'),
		currentUid: v.string(),
		state: v.union(
			v.literal('ready'),
			v.literal('in-progress'),
			v.literal('uncertain'),
			v.literal('completed'),
			v.literal('unavailable')
		)
	}),
	v.object({ kind: v.literal('unavailable') })
);
const customerPendingTemplate = v.object({ filename: v.string() });
export const templateSetupStatus = v.union(
	v.object({ kind: v.literal('released') }),
	v.object({ kind: v.literal('upload') }),
	v.object({ kind: v.literal('waiting'), pending: customerPendingTemplate }),
	v.object({
		kind: v.literal('booking'),
		booking: setupCalendarTarget,
		pending: v.union(customerPendingTemplate, v.null())
	})
);
