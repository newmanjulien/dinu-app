import type { Infer } from 'convex/values';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type * as validators from './validators';
import { instructions as instructionContent } from './validators';
export type { SourcePoint, SourceRange, SourceTarget } from '../contract/source-model';
export type Trigger = Infer<typeof validators.trigger>;
export type AuthoringInstructions = Instructions & { changesNeedApproval?: string };
export type Instructions = Infer<typeof validators.instructions>;
export type ContractChange = Infer<typeof validators.contractChange>;
export type Concession = Infer<typeof validators.concession>;
export type PlaybookItem = Infer<typeof validators.playbookItem>;
export type PlaybookItemId = Id<'playbookItems'>;
/** Identity shared by mutable heads and immutable snapshot entries. */
export type PlaybookItemRecord = Pick<
	Doc<'playbookItems'>,
	'_id' | '_creationTime' | 'contentRevision'
> &
	PlaybookItem & { renderKey?: string };
export type ConcessionSelection = Readonly<Record<string, string>>;
export function sameSelection(a: ConcessionSelection, b: ConcessionSelection): boolean {
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
	item: Pick<PlaybookItem, 'instructions' | 'approvalPolicy'>
): AuthoringInstructions {
	return {
		...item.instructions,
		changesNeedApproval:
			item.approvalPolicy.kind === 'required' ? item.approvalPolicy.instructions : ''
	};
}
