import { validateStorageArrays } from '../contract/storage-limits';
import { PlaybookValidationError } from './validation-error';
export { MAX_CONTRACT_BLOCKS, MAX_PLAYBOOK_ITEM_BYTES, MAX_PLAYBOOK_ITEMS } from './limits';
export { PlaybookValidationError } from './validation-error';

import type { CompiledContract } from '../contract/compiled-contract';
import { targetContainers } from '../contract/ranges';
import { hasMeaningfulReplacement } from '../contract/replacement-content';
import type { ValidationSourceFacts } from '../contract/validation-source';
import { createChangeConflictChecker } from './conflicts';
import { equalConcession } from './content';
import { changeTriggerOwner, triggersIntersect, validateTriggerRange } from './geometry';
import type { Concession, ContractChange, PlaybookItem, Trigger } from './model';

import { MAX_PLAYBOOK_ITEM_BYTES } from './limits';

export function validateConcessions(concessions: readonly Concession[]): void {
	for (const concession of concessions)
		if (concession.changes.length > 2)
			throw new PlaybookValidationError('A concession can affect at most two selections');
}

/** Retained concessions are read-only. All content uses the same authoring limits. */
export function validateConcessionUpdate(saved: PlaybookItem, proposed: PlaybookItem): void {
	const retained = new Map(saved.concessions.map((concession) => [concession.id, concession]));
	for (const concession of proposed.concessions) {
		const existing = retained.get(concession.id);
		if (existing && !equalConcession(existing, concession))
			throw new PlaybookValidationError(
				'Existing concessions are read-only. Delete the concession and add a new one to change it.'
			);
	}
}

function unique(seen: Set<string>, id: string, label: string): void {
	if (!id.trim() || id !== id.trim()) throw new PlaybookValidationError(`Invalid ${label}`);
	if (seen.has(id)) throw new PlaybookValidationError(`Duplicate ${label}: ${id}`);
	seen.add(id);
}

/** Also used by source picking, while an item can still be incomplete. */
export function validateTriggers(index: ValidationSourceFacts, triggers: readonly Trigger[]): void {
	const ids = new Set<string>();
	for (const [i, trigger] of triggers.entries()) {
		unique(ids, trigger.id, 'Trigger ID');
		validateTriggerRange(index, trigger.target);
		for (const other of triggers.slice(0, i))
			if (triggersIntersect(index, other.target, trigger.target))
				throw new PlaybookValidationError(`Overlapping Triggers: ${other.id}, ${trigger.id}`);
	}
}

/** Validate change ownership and conflicts independently of replacement wording. */
export function validateChangeGeometry(
	index: ValidationSourceFacts,
	triggers: readonly Trigger[],
	changes: readonly ContractChange[]
): void {
	const conflicts = createChangeConflictChecker(index);
	for (const [i, change] of changes.entries()) {
		if (
			change.replacement.some((atom) => atom.kind === 'paragraph-break') &&
			targetContainers(index, change.target).some(
				(container) =>
					change.target.kind !== 'boundary' &&
					index.blocks.get(container.blockKey)?.kind !== 'paragraph'
			)
		)
			throw new PlaybookValidationError('Paragraph replacements must target contract paragraphs');
		changeTriggerOwner(index, triggers, change);
		for (let j = 0; j < i; j++)
			if (conflicts(changes[j], change))
				throw new PlaybookValidationError(`Conflicting changes: ${i + 1}`);
	}
}

/** Final items cannot reserve a structural location without changing the contract. */
export function validateStructuralReplacementContent(
	item: Pick<PlaybookItem, 'concessions'>
): void {
	for (const concession of item.concessions)
		for (const change of concession.changes)
			if (change.target.kind === 'boundary' && !hasMeaningfulReplacement(change.replacement))
				throw new PlaybookValidationError(
					'A structural concession needs text or a reference before it can be saved.'
				);
}

/** Source-independent checks shared by structural validation and instructions-only saves. */
export function validatePlaybookItemContent(item: PlaybookItem): void {
	validateStorageArrays(item);
	if (item.approvalPolicy.kind === 'required' && !item.approvalPolicy.instructions.trim())
		throw new PlaybookValidationError('Approval instructions cannot be blank');
	if (new TextEncoder().encode(JSON.stringify(item)).byteLength > MAX_PLAYBOOK_ITEM_BYTES)
		throw new PlaybookValidationError('Playbook Item exceeds 500 KB');
	for (const target of [
		item.trigger.target,
		...item.concessions.flatMap((concession) => concession.changes.map((change) => change.target))
	]) {
		if (target.kind !== 'text') continue;
		for (const point of [target.range.start, target.range.end])
			if (!Number.isSafeInteger(point.offset) || point.offset < 0)
				throw new PlaybookValidationError(
					`Invalid source point: ${point.sourceKey}@${point.offset}`
				);
	}
	unique(new Set(), item.trigger.id, 'Trigger ID');
	validateConcessions(item.concessions);
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
	item: Pick<PlaybookItem, 'concessions'>
): void {
	for (const concession of item.concessions)
		for (const change of concession.changes)
			for (const atom of change.replacement) if (atom.kind === 'reference') validateReference(atom);
}
