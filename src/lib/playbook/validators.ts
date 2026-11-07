import { v } from 'convex/values';
import { replacementAtom, sourceTarget } from '../contract/source-validators';

// Persisted Playbook business data only.
export const instructions = v.object({
	summary: v.optional(v.string()),
	howToExplainToBuyers: v.optional(v.string()),
	commonObjections: v.optional(v.string()),
	negotiation: v.optional(v.string())
});

export const trigger = v.object({ id: v.string(), target: sourceTarget });
export const contractChange = v.object({
	target: sourceTarget,
	replacement: v.array(replacementAtom)
});
export const concession = v.object({
	id: v.string(),
	tier: v.union(v.literal('preferred'), v.literal('rare')),
	description: v.string(),
	changes: v.array(contractChange)
});
export const approvalPolicy = v.union(
	v.object({ kind: v.literal('none') }),
	v.object({ kind: v.literal('required'), instructions: v.string() })
);
export const playbookItem = v.object({
	approvalPolicy,
	trigger,
	instructions: v.optional(instructions),
	concessions: v.array(concession)
});
