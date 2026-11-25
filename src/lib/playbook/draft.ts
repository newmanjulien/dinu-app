import type { DeepReadonly } from '../immutable';
import { semanticTarget } from './content';
import type {
	BuyerExplanation,
	RepInstruction,
	TemplateItemId,
	SourceTarget,
	TextSourceTarget,
	TemplateAudience,
	TemplateItem
} from './model';
import { newTriggerId } from './model';

export type RepInstructionDraft = RepInstruction & {
	persistedId?: TemplateItemId;
};
export type BuyerExplanationDraft = BuyerExplanation & {
	persistedId?: TemplateItemId;
};
export type TemplateDraft = RepInstructionDraft | BuyerExplanationDraft;
export type ReadonlyDraft = DeepReadonly<TemplateDraft>;

export function newTemplateDraft(range: TextSourceTarget, audience: 'buyer'): BuyerExplanationDraft;
export function newTemplateDraft(range: SourceTarget, audience: 'rep'): RepInstructionDraft;
export function newTemplateDraft(range: SourceTarget, audience: TemplateAudience): TemplateDraft {
	if (audience === 'buyer') {
		if (range.kind !== 'text') throw new Error('Buyer explanations require selected text.');
		return {
			audience: 'buyer',
			trigger: { id: newTriggerId(), target: semanticTarget(range) },
			explanation: ''
		};
	}
	return {
		audience: 'rep',
		instructions: {},
		approvalPolicy: { kind: 'none' },
		trigger: { id: newTriggerId(), target: semanticTarget(range) },
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
