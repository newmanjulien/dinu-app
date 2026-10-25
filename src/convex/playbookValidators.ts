import { v } from 'convex/values';
import { replacementAtom, sourceRange } from './sourceValidators';

// Persisted Playbook business data only.
export const instructions = v.object({
	summary: v.optional(v.string()),
	howToExplainToBuyers: v.optional(v.string()),
	commonObjections: v.optional(v.string()),
	negotiation: v.optional(v.string()),
	changesNeedApproval: v.optional(v.string())
});

export const trigger = v.object({ id: v.string(), range: sourceRange });
export const contractChange = v.object({
	range: sourceRange,
	replacement: v.array(replacementAtom)
});
export const concession = v.object({
	id: v.string(),
	tier: v.union(v.literal('preferred'), v.literal('rare')),
	description: v.string(),
	// Preserve production concession copy without folding notes into the description.
	detail: v.optional(v.array(v.string())),
	after: v.optional(v.string()),
	changes: v.array(contractChange)
});
export const playbookItem = v.object({
	triggers: v.array(trigger),
	instructions: v.optional(instructions),
	concessions: v.array(concession)
});

// Historical content retains the original authoring metadata, never its revision head.
export const historicalItem = playbookItem.extend({
	_id: v.id('playbookItems'),
	_creationTime: v.number(),
	companyId: v.id('company'),
	revision: v.number(),
	lastOperationId: v.optional(v.string()),
	lastOperationCaller: v.optional(v.id('profiles'))
});
