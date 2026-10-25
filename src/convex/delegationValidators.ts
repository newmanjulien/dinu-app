import { v, type Infer } from 'convex/values';

export const delegate = v.object({
	name: v.string(),
	introduction: v.string(),
	avatarPath: v.string()
});
export const task = v.object({
	key: v.string(),
	title: v.string(),
	description: v.string(),
	businessDays: v.number(),
	questions: v.array(
		v.object({
			key: v.string(),
			label: v.string(),
			required: v.boolean(),
			kind: v.union(v.literal('text'), v.literal('textarea'))
		})
	)
});
export const catalog = v.object({
	key: v.literal('default'),
	revision: v.number(),
	delegate,
	tasks: v.array(task)
});
export const submission = v.object({
	draftId: v.string(),
	catalogRevision: v.number(),
	taskKey: v.string(),
	answers: v.record(v.string(), v.string()),
	attachmentIds: v.array(v.id('delegationAttachments'))
});
export const submitted = v.object({ requestId: v.id('delegationRequests'), dueDate: v.string() });
export const request = v.object({
	companyId: v.id('company'),
	submitterId: v.id('profiles'),
	operationId: v.string(),
	payload: submission,
	snapshot: v.object({ delegate, task }),
	submittedAt: v.number(),
	dueDate: v.string(),
	timezone: v.literal('America/Toronto')
});
const attachmentBase = v.object({
	storageId: v.id('_storage'),
	companyId: v.id('company'),
	uploaderId: v.id('profiles'),
	draftId: v.string(),
	uploadId: v.string(),
	filename: v.string(),
	size: v.number(),
	contentType: v.string(),
	sha256: v.string()
});
export const attachment = v.union(
	attachmentBase.extend({ state: v.literal('staged'), expiresAt: v.number() }),
	attachmentBase.extend({ state: v.literal('submitted'), requestId: v.id('delegationRequests') })
);
export const draftAttachment = v.object({
	_id: v.id('delegationAttachments'),
	uploadId: v.string(),
	expiresAt: v.number()
});
export const registeredUpload = v.object({
	attachmentId: v.id('delegationAttachments'),
	storageId: v.id('_storage')
});
export const cancellation = v.object({
	companyId: v.id('company'),
	uploaderId: v.id('profiles'),
	draftId: v.string(),
	uploadId: v.union(v.string(), v.null()),
	expiresAt: v.number()
});
export const uploadArgs = v.object({
	membershipId: v.id('memberships'),
	draftId: v.string(),
	uploadId: v.string()
});
export type Task = Infer<typeof task>;
export type Catalog = Infer<typeof catalog>;
export type Submission = Infer<typeof submission>;
export type Submitted = Infer<typeof submitted>;
