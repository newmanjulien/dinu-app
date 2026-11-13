import { v } from 'convex/values';
import { approvalContext } from '../lib/contract/changes';
import { approvalRequest } from './contractValidators';

/** Bounded cursor on the original receipt; immutable entries belong to its delivery. */
export const emailPreparation = v.object({
	deliveryId: v.id('emailDeliveries'),
	generation: v.number(),
	unit: v.number(),
	dueAt: v.number(),
	cursor: v.union(v.string(), v.null()),
	done: v.boolean(),
	order: v.number(),
	count: v.number(),
	bytes: v.number(),
	hash: v.string()
});
export const approvalRequestArgs = v.object({
	membershipId: v.id('memberships'),
	id: v.id('savedContracts'),
	context: approvalContext,
	expectedDocument: v.object({
		documentId: v.id('contractDocuments'),
		documentRevision: v.number()
	}),
	expectedIdentity: v.string(),
	token: v.optional(v.string()),
	operationId: v.string()
});
export const confirmCompletionArgs = v.object({
	membershipId: v.id('memberships'),
	id: v.id('savedContracts'),
	context: approvalContext,
	expectedIdentity: v.string(),
	token: v.optional(v.string()),
	operationId: v.string(),
	notify: v.boolean()
});
export const emailOperationResult = v.object({
	status: v.union(v.literal('complete'), v.literal('preparing')),
	operationId: v.string(),
	request: v.optional(approvalRequest),
	outcome: v.optional(v.union(v.literal('queued'), v.literal('dismissed'), v.literal('stale')))
});
