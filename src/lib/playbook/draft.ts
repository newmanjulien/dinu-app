import type { DeepReadonly } from '../immutable';
import { semanticTarget } from './content';
import type {
	AuthoringInstructions,
	BuyerExplanation,
	RepInstruction,
	TemplateItemId,
	SourceTarget,
	TemplateAudience,
	TemplateItem
} from './model';
import { authoringInstructions, isRepItem, newTriggerId } from './model';

export type RepInstructionDraft = RepInstruction & {
	instructions: AuthoringInstructions;
	persistedId?: TemplateItemId;
};
export type TemplateDraft =
	RepInstructionDraft | (BuyerExplanation & { persistedId?: TemplateItemId });
export type ReadonlyDraft = DeepReadonly<TemplateDraft>;

export function newTemplateDraft(
	range: SourceTarget,
	audience: TemplateAudience = 'rep'
): TemplateDraft {
	const trigger = { id: newTriggerId(), target: semanticTarget(range) };
	return audience === 'buyer'
		? { audience, trigger, explanation: '' }
		: {
				instructions: {},
				approvalPolicy: { kind: 'none' },
				trigger,
				concessions: []
			};
}

/** Editor-only approval guidance belongs exclusively to rep instructions. */
export function templateDraft(
	item: DeepReadonly<TemplateItem>,
	persistedId?: TemplateItemId
): ReadonlyDraft {
	const identity = persistedId ? { persistedId } : {};
	return isRepItem(item)
		? { ...item, instructions: authoringInstructions(item), ...identity }
		: { ...item, ...identity };
}
