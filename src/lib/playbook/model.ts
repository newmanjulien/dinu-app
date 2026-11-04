import type { Doc, Id } from '../../convex/_generated/dataModel';
import type { Infer } from 'convex/values';
import type * as validators from '../../convex/playbookValidators';
import {
	isCanonicalSourceTarget,
	normalizeSourceTarget,
	type SourceTarget,
	type StoredSourceTarget
} from '../contract/source-model';

export type { SourcePoint, SourceRange, SourceTarget } from '../contract/source-model';
type StoredTrigger = Infer<typeof validators.trigger>;
type StoredContractChange = Infer<typeof validators.contractChange>;
type StoredConcession = Infer<typeof validators.concession>;
/** Storage/API shape accepts legacy ranges only at the system boundary. */
export type StoredPlaybookItem = Infer<typeof validators.playbookItem>;

/** Canonical domain values never expose the legacy serialized `gap:` range. */
export type Trigger = Omit<StoredTrigger, 'range'> & { range: SourceTarget };
export type Instructions = Infer<typeof validators.instructions>;
export type ContractChange = Omit<StoredContractChange, 'range'> & { range: SourceTarget };
export type Concession = Omit<StoredConcession, 'changes'> & { changes: ContractChange[] };
export type PlaybookItem = Omit<StoredPlaybookItem, 'trigger' | 'concessions'> & {
	trigger: Trigger;
	concessions: Concession[];
};
export type PlaybookItemId = Id<'playbookItems'>;
/** Identity shared by mutable heads and immutable snapshot entries. */
export type PlaybookItemRecord =
	Pick<Doc<'playbookItems'>, '_id' | '_creationTime' | 'revision'> & PlaybookItem;
export type StoredPlaybookItemRecord =
	Pick<Doc<'playbookItems'>, '_id' | '_creationTime' | 'revision'> & StoredPlaybookItem;
export type ConcessionSelection = Readonly<Record<string, string>>;
export type NormalizedPlaybookItem<T> = Omit<T, 'trigger' | 'concessions'> & PlaybookItem;

function normalizedChange(change: StoredContractChange | ContractChange): ContractChange {
	return { ...change, range: normalizeSourceTarget(change.range as StoredSourceTarget) };
}

function isCanonicalPlaybookItem(
	item: StoredPlaybookItem | PlaybookItem
): item is PlaybookItem {
	return (
		isCanonicalSourceTarget(item.trigger.range as StoredSourceTarget) &&
		item.concessions.every((concession) =>
			concession.changes.every((change) =>
				isCanonicalSourceTarget(change.range as StoredSourceTarget)
			)
		)
	);
}

/** Apply migration compatibility once at every storage/network ingress. */
export function normalizePlaybookItem<T extends StoredPlaybookItem | PlaybookItem>(
	item: T
): NormalizedPlaybookItem<T> {
	if (isCanonicalPlaybookItem(item)) return item as NormalizedPlaybookItem<T>;
	return {
		...item,
		trigger: { ...item.trigger, range: normalizeSourceTarget(item.trigger.range as StoredSourceTarget) },
		concessions: item.concessions.map((concession) => ({
			...concession,
			changes: concession.changes.map(normalizedChange)
		}))
	} as NormalizedPlaybookItem<T>;
}

export function normalizePlaybookItemRecord(
	item: StoredPlaybookItemRecord | PlaybookItemRecord
): PlaybookItemRecord {
	return normalizePlaybookItem(item) as PlaybookItemRecord;
}

export function sameSelection(a: ConcessionSelection, b: ConcessionSelection): boolean {
	return (
		Object.keys(a).length === Object.keys(b).length &&
		Object.entries(a).every(([key, value]) => b[key] === value)
	);
}

/** Generate once on authoring, never during rendering or projection. */
export const newTriggerId = (): string => crypto.randomUUID();
export const newConcessionId = (): string => crypto.randomUUID();
