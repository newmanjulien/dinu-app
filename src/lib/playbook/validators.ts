import { v } from 'convex/values';
import { replacementAtom, sourceTarget, textSourceTarget } from '../document/source-validators';

// Persisted Playbook business data only.
export const instructions = v.object({
	summary: v.optional(v.string()),
	howToExplainToBuyers: v.optional(v.string()),
	commonObjections: v.optional(v.string()),
	negotiation: v.optional(v.string())
});

export const trigger = v.object({ id: v.string(), target: sourceTarget });
export const textTrigger = v.object({ id: v.string(), target: textSourceTarget });
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
export const repInstruction = v.object({
	audience: v.literal('rep'),
	approvalPolicy,
	trigger,
	instructions,
	concessions: v.array(concession)
});

export const templateAudience = v.union(v.literal('rep'), v.literal('buyer'));
export const buyerExplanation = v.object({
	audience: v.literal('buyer'),
	trigger: textTrigger,
	explanation: v.string()
});
export const templateItem = v.union(repInstruction, buyerExplanation);
