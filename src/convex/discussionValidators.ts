import { v } from 'convex/values';
import { discussionAnchor, discussionFootprint } from '../lib/discussions/validators';

const ownership = {
	companyId: v.id('company'),
	contractId: v.id('savedContracts')
};

/** Every stored thread is live; invalidated or root-deleted threads are hard-deleted with their messages. */
export const storedThread = v.object({
	...ownership,
	contentRevision: v.number(),
	anchor: discussionAnchor,
	footprint: discussionFootprint,
	unreadMessageCount: v.number(),
	hasUnread: v.boolean()
});

export const storedMessage = v.object({
	...ownership,
	threadId: v.id('discussionThreads'),
	reply: v.boolean(),
	authorKey: v.string(),
	operationId: v.optional(v.string()),
	profileId: v.optional(v.id('profiles')),
	text: v.string(),
	revision: v.number(),
	unreadByTeam: v.boolean()
});
