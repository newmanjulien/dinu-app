import { PlaybookValidationError } from './validation-error';
import { validateStorageArrays } from '../contract/storage-limits';
export { PlaybookValidationError } from './validation-error';

import type { SourceIndex } from '../contract/source-index';
import type { CompiledContract } from '../contract/compiled-contract';
import type { Concession, ContractChange, PlaybookItem, Trigger } from './model';
import {
	activatedBlock,
	changeTriggerOwner,
	triggersIntersect,
	validateTriggerRange
} from './geometry';
import { createChangeConflictChecker } from './conflicts';
import { equalConcession } from './draft';

// Leave headroom under Convex's document limit for its system fields and encoding.
export const MAX_PLAYBOOK_ITEM_BYTES = 500_000;
export const MAX_PLAYBOOK_ITEMS = 4096;
export const MAX_CONTRACT_BLOCKS = 4096;

export function validateNewConcessions(concessions: readonly Concession[]): void {
	for (const concession of concessions)
		if (concession.changes.length > 2)
			throw new PlaybookValidationError('A concession can affect at most two clauses');
}

/** Retained concessions are read-only; creation limits apply only to new IDs. */
export function validateConcessionUpdate(saved: PlaybookItem, proposed: PlaybookItem): void {
	const retained = new Map(saved.concessions.map((concession) => [concession.id, concession]));
	for (const concession of proposed.concessions) {
		const existing = retained.get(concession.id);
		if (existing && !equalConcession(existing, concession))
			throw new PlaybookValidationError(
				'Existing concessions are read-only. Delete the concession and add a new one to change it.'
			);
	}
	validateNewConcessions(proposed.concessions.filter((concession) => !retained.has(concession.id)));
}

function unique(seen: Set<string>, id: string, label: string): void {
	if (!id.trim() || id !== id.trim()) throw new PlaybookValidationError(`Invalid ${label}`);
	if (seen.has(id)) throw new PlaybookValidationError(`Duplicate ${label}: ${id}`);
	seen.add(id);
}

/** Also used by source picking, while an item can still be incomplete. */
export function validateTriggers(index: SourceIndex, triggers: readonly Trigger[]): void {
	const ids = new Set<string>();
	for (const [i, trigger] of triggers.entries()) {
		unique(ids, trigger.id, 'Trigger ID');
		validateTriggerRange(index, trigger.range);
		for (const other of triggers.slice(0, i))
			if (triggersIntersect(index, other.range, trigger.range))
				throw new PlaybookValidationError(`Overlapping Triggers: ${other.id}, ${trigger.id}`);
	}
}

/** Validate change ownership and conflicts independently of replacement wording. */
export function validateChangeGeometry(
	index: SourceIndex,
	triggers: readonly Trigger[],
	changes: readonly ContractChange[]
): void {
	const conflicts = createChangeConflictChecker(index);
	for (const [i, change] of changes.entries()) {
		changeTriggerOwner(index, triggers, change);
		activatedBlock(index, change);
		for (let j = 0; j < i; j++)
			if (conflicts(changes[j], change))
				throw new PlaybookValidationError(`Conflicting changes: ${i + 1}`);
	}
}

/** Source-independent checks shared by structural validation and instructions-only saves. */
export function validatePlaybookItemContent(item: PlaybookItem): void {
	validateStorageArrays(item);
	if (new TextEncoder().encode(JSON.stringify(item)).byteLength > MAX_PLAYBOOK_ITEM_BYTES)
		throw new PlaybookValidationError('Playbook Item exceeds 500 KB');
	if (!item.triggers.length)
		throw new PlaybookValidationError('A Playbook Item needs at least one Trigger');
	const concessionIds = new Set<string>();
	for (const concession of item.concessions) {
		unique(concessionIds, concession.id, 'concession ID');
		if (concession.tier !== 'preferred' && concession.tier !== 'rare')
			throw new PlaybookValidationError('Invalid concession tier');
	}
}

/** Reference checks are independent of cross-item geometry and safe on every keystroke. */
export function validateChangeReferences(
	{ validateReference }: Pick<CompiledContract, 'validateReference'>,
	item: PlaybookItem
): void {
	for (const concession of item.concessions)
		for (const change of concession.changes)
			for (const atom of change.replacement) if (atom.kind === 'reference') validateReference(atom);
}
