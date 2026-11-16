import { v, type Infer } from 'convex/values';
import { contractItemId } from './item-identity';
import { contractChange, instructions } from '../playbook/validators';
import { semanticConcession, semanticInstructions, semanticTarget } from '../playbook/content';
import { sourceTarget } from '../document/source-validators';
import type { RepInstructionRecord } from '../playbook/model';
import type { DeepReadonly } from '../immutable';

/** Contract semantics are independent of the template authoring rule that supplied them. */
export const resolvedContractItem = v.object({
	_id: contractItemId,
	_creationTime: v.number(),
	contentRevision: v.number(),
	origin: v.object({ kind: v.literal('template'), instructions: v.optional(instructions) }),
	primary: v.object({ id: v.string(), target: sourceTarget, changeIndex: v.number() }),
	review: v.union(
		v.object({ kind: v.literal('none') }),
		v.object({ kind: v.literal('required'), instructions: v.optional(v.string()) })
	),
	choices: v.array(
		v.object({
			id: v.string(),
			description: v.string(),
			changes: v.array(contractChange.extend({ suppressed: v.optional(v.boolean()) })),
			tier: v.optional(v.union(v.literal('preferred'), v.literal('rare')))
		})
	)
});
export type ResolvedContractItem = Infer<typeof resolvedContractItem>;
export type DocumentItemRecord = RepInstructionRecord | ResolvedContractItem;
export function resolveTemplateItem(
	item: DeepReadonly<RepInstructionRecord>
): ResolvedContractItem {
	const instructions = semanticInstructions(item.instructions);
	return {
		_id: item._id,
		_creationTime: item._creationTime,
		contentRevision: item.contentRevision,
		origin: { kind: 'template', ...(instructions ? { instructions } : {}) },
		primary: { id: item.trigger.id, target: semanticTarget(item.trigger.target), changeIndex: 0 },
		review:
			item.approvalPolicy.kind === 'required'
				? { kind: 'required', instructions: item.approvalPolicy.instructions }
				: { kind: 'none' },
		choices: item.concessions.map(semanticConcession)
	};
}
