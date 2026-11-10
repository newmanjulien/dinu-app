import type { ContractItemId } from '../contract/item-identity';
import type { DeepReadonly } from '../immutable';
import type { Infer } from 'convex/values';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type * as validators from './validators';
import { instructions as instructionContent } from './validators';
export type { SourcePoint, SourceRange, SourceTarget } from '../document/source-model';
export type Trigger = Infer<typeof validators.trigger>;
export type AuthoringInstructions = Instructions & { changesNeedApproval?: string };
export type Instructions = Infer<typeof validators.instructions>;
export type ContractChange = Infer<typeof validators.contractChange>;
export type Concession = Infer<typeof validators.concession>;
export type PlaybookItem = Infer<typeof validators.playbookItem>;
export type InstructionAudience = Infer<typeof validators.instructionAudience>;
export type BuyerInstruction = Infer<typeof validators.buyerInstruction>;
export type TemplateItem = Infer<typeof validators.templateItem>;
export const isRepItem = <T extends { trigger: Trigger }>(
	item: T
): item is Exclude<T, { audience: 'buyer' }> => !('audience' in item && item.audience === 'buyer');
export const itemAudience = (item: { trigger: Trigger; audience?: 'buyer' }): InstructionAudience =>
	item.audience ?? 'rep';
export type PlaybookItemId = Id<'playbookItems'>;
/** Identity shared by mutable heads and immutable snapshot entries. */
export type PlaybookItemRecord<ItemId extends ContractItemId = Id<'playbookItems'>> = Pick<
	Doc<'playbookItems'>,
	'_creationTime' | 'contentRevision'
> &
	PlaybookItem & { _id: ItemId; renderKey?: string };
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

export const authoringInstructionKeys = [...instructionKeys, 'changesNeedApproval'] as const;

/** The existing text editor presents policy guidance; business rules read policy.kind. */
export function authoringInstructions(
	item: DeepReadonly<Pick<PlaybookItem, 'instructions' | 'approvalPolicy'>>
): AuthoringInstructions {
	return {
		...item.instructions,
		changesNeedApproval:
			item.approvalPolicy.kind === 'required' ? item.approvalPolicy.instructions : ''
	};
}

export type ContractItemRecord = PlaybookItemRecord<ContractItemId>;
