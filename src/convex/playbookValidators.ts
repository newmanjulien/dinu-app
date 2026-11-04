import { v } from 'convex/values';
import { replacementAtom, sourceTarget } from './sourceValidators';

// Persisted Playbook business data only.
export const instructions = v.object({
	summary: v.optional(v.string()),
	howToExplainToBuyers: v.optional(v.string()),
	commonObjections: v.optional(v.string()),
	negotiation: v.optional(v.string()),
	changesNeedApproval: v.optional(v.string())
});

export const trigger = v.object({ id: v.string(), range: sourceTarget });
export const contractChange = v.object({
	range: sourceTarget,
	replacement: v.array(replacementAtom)
});
export const concession = v.object({
	id: v.string(),
	tier: v.union(v.literal('preferred'), v.literal('rare')),
	description: v.string(),
	changes: v.array(contractChange)
});
export const playbookItem = v.object({
	trigger,
	instructions: v.optional(instructions),
	concessions: v.array(concession)
});

// Historical identity describes the original item, never the transport operation.
export const historicalItem = playbookItem.extend({
	_id: v.id('playbookItems'),
	_creationTime: v.number(),
	companyId: v.id('company'),
	revision: v.number()
});
