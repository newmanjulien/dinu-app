import type { ContractItemId } from '../contract/item-identity';
import type { Infer } from 'convex/values';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type * as validators from './validators';
import { instructions as instructionContent } from './validators';
export type { SourcePoint, SourceRange, SourceTarget } from '../document/source-model';
export type Trigger = Infer<typeof validators.trigger>;
export type Instructions = Infer<typeof validators.instructions>;
export type ApprovalPolicy = Infer<typeof validators.approvalPolicy>;
export type ContractChange = Infer<typeof validators.contractChange>;
export type Concession = Infer<typeof validators.concession>;
export type RepInstruction = Infer<typeof validators.repInstruction>;
export type TemplateAudience = Infer<typeof validators.templateAudience>;
export type BuyerExplanation = Infer<typeof validators.buyerExplanation>;
export type TemplateItem = Infer<typeof validators.templateItem>;
export const isRepItem = <T extends { audience: TemplateAudience }>(
	item: T
): item is Extract<T, { audience: 'rep' }> => item.audience === 'rep';
export type TemplateItemId = Id<'playbookItems'>;
/** Identity shared by mutable heads and immutable snapshot entries. */
export type RepInstructionRecord<ItemId extends ContractItemId = Id<'playbookItems'>> = Pick<
	Doc<'playbookItems'>,
	'_creationTime' | 'contentRevision'
> &
	RepInstruction & { _id: ItemId; renderKey?: string };
export type ConcessionSelection = Readonly<Record<string, string>>;
export function sameSelection(a: ConcessionSelection, b: ConcessionSelection): boolean {
	if (a === b) return true;
	return (
		Object.keys(a).length === Object.keys(b).length &&
		Object.entries(a).every(([key, value]) => b[key] === value)
	);
}

/** Generate once on authoring, never during rendering or projection. */
export const newTriggerId = (): string => crypto.randomUUID();
export const newConcessionId = (): string => crypto.randomUUID();

/** Business fields, independent of their labels or editor presentation. */
export const instructionKeys = Object.keys(instructionContent.fields) as (keyof Instructions)[];

export type ContractItemRecord = import('../contract/items').ResolvedContractItem;
