import type { DeepReadonly } from '../immutable';
import { semanticTarget } from './content';
import type {
	BuyerExplanation,
	RepInstruction,
	TemplateItemId,
	SourceTarget,
	TemplateAudience,
	TemplateItem
} from './model';
import { newTriggerId } from './model';

export type RepInstructionDraft = RepInstruction & {
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
				audience,
				instructions: {},
				approvalPolicy: { kind: 'none' },
				trigger,
				concessions: []
			};
}

/** Drafts retain the canonical business shape for both audiences. */
export function templateDraft(
	item: DeepReadonly<TemplateItem>,
	persistedId?: TemplateItemId
): ReadonlyDraft {
	const identity = persistedId ? { persistedId } : {};
	return { ...item, ...identity };
}
