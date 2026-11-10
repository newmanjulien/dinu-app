import { v } from 'convex/values';
import { playbookItem, buyerInstruction } from '../lib/playbook/validators';
export {
	concession,
	contractChange,
	instructions,
	playbookItem,
	trigger
} from '../lib/playbook/validators';

// Historical identity describes the original item, never the transport operation.
const historicalFields = {
	_id: v.id('playbookItems'),
	_creationTime: v.number(),
	companyId: v.id('company'),
	contentRevision: v.number()
};

export const historicalRepItem = playbookItem.extend(historicalFields);
export const historicalBuyerItem = buyerInstruction.extend(historicalFields);
export const historicalItem = v.union(historicalRepItem, historicalBuyerItem);

/** Mutable business head; replay identity is absent or complete. */
const detailFields = {
	currentRevisionId: v.optional(v.id('playbookItemRevisions')),
	lastOperation: v.optional(v.object({ id: v.string(), callerId: v.id('profiles') })),
	renderKey: v.string()
};
export const hydratedPlaybookItem = v.union(
	historicalRepItem.extend(detailFields),
	historicalBuyerItem.extend(detailFields)
);
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
