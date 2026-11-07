import { v } from 'convex/values';
import { playbookItem } from '../lib/playbook/validators';
export {
	concession,
	contractChange,
	instructions,
	playbookItem,
	trigger
} from '../lib/playbook/validators';

// Historical identity describes the original item, never the transport operation.
export const historicalItem = playbookItem.extend({
	_id: v.id('playbookItems'),
	_creationTime: v.number(),
	companyId: v.id('company'),
	contentRevision: v.number()
});

/** Mutable business head; replay identity is absent or complete. */
export const hydratedPlaybookItem = historicalItem.extend({
	currentRevisionId: v.optional(v.id('playbookItemRevisions')),
	lastOperation: v.optional(v.object({ id: v.string(), callerId: v.id('profiles') })),
	renderKey: v.string()
});
export const itemHeadFields = {
	companyId: v.id('company'),
	contentRevision: v.number(),
	currentRevisionId: v.optional(v.id('playbookItemRevisions')),
	lastOperation: v.optional(v.object({ id: v.string(), callerId: v.id('profiles') }))
};
export const storedPlaybookItem = v.union(
	v.object({
		...itemHeadFields,
		format: v.literal(1),
		renderKey: v.string(),
		structure: v.bytes()
	}),
	playbookItem.extend({
		companyId: v.id('company'),
		contentRevision: v.number(),
		currentRevisionId: v.optional(v.id('playbookItemRevisions')),
		lastOperation: v.optional(v.object({ id: v.string(), callerId: v.id('profiles') }))
	})
);
