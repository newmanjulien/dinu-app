import type {
	ContractSnapshotResult,
	ContractState,
	SavedSelections,
	ReadyContract,
	ContractSnapshot
} from './saved';
import { MAX_CONTRACT_BLOCKS, MAX_PLAYBOOK_ITEMS } from '../playbook/limits';
import { MAX_STORAGE_ARRAY_ENTRIES } from './storage-limits';
import { MAX_SELECTED_CONCESSIONS, MAX_APPLICATION_LIFECYCLE_LENGTH } from './selection-limits';

// Disk data is unknown even though network data is validated by Convex. These
// checks describe the persisted domain, without interpreting a schema language
// or importing server validators into the browser. Semantic source/geometry
// validation stays with publication and compilation.
function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === 'string';
const finite = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);
const natural = (value: unknown): value is number =>
	finite(value) && Number.isSafeInteger(value) && value >= 0;
function array(
	value: unknown,
	check: (entry: unknown) => boolean,
	max = MAX_STORAGE_ARRAY_ENTRIES
) {
	if (!Array.isArray(value) || value.length > max) return false;
	// Visit holes as undefined too: a sparse disk array is not valid content.
	for (const entry of value) if (!check(entry)) return false;
	return true;
}
export function validSelections(value: unknown): value is SavedSelections {
	return (
		object(value) &&
		Object.keys(value).length <= MAX_SELECTED_CONCESSIONS &&
		Object.entries(value).every(([id, choice]) => id.length > 0 && text(choice))
	);
}
export function validLifecycle(value: unknown): value is string {
	return text(value) && value.trim().length > 0 && value.length <= MAX_APPLICATION_LIFECYCLE_LENGTH;
}
export function validLifecycles(value: unknown): value is Record<string, string> {
	return validSelections(value) && Object.values(value).every(validLifecycle);
}
function validCompletion(value: unknown) {
	return (
		value === null ||
		(object(value) &&
			!('generation' in value) &&
			((value.kind === 'awaitingConfirmation' && text(value.reviewerId)) ||
				(value.kind === 'queued' && text(value.deliveryId))))
	);
}
export function validContractState(value: unknown): value is ContractState {
	return (
		object(value) &&
		text(value.companyName) &&
		natural(value.revision) &&
		natural(value.stateVersion) &&
		natural(value.reviewGeneration) &&
		validCompletion(value.reviewCompletion) &&
		(value.lastOperationId === null || text(value.lastOperationId)) &&
		validSelections(value.selectedConcessions) &&
		object(value.reviews) &&
		Object.keys(value.reviews).length <= MAX_SELECTED_CONCESSIONS &&
		Object.entries(value.reviews).every(
			([id, review]) =>
				id.length > 0 &&
				object(review) &&
				text(review.concessionId) &&
				validLifecycle(review.lifecycle) &&
				(review.status === 'pending' ||
					review.status === 'approved' ||
					review.status === 'rejected')
		)
	);
}
type Metadata = Extract<ContractSnapshotResult, { status: 'ready' }>['contract'];
export function validContractMetadata(value: unknown, id: string): value is Metadata {
	return (
		object(value) &&
		value._id === id &&
		text(value.creatorId) &&
		text(value.companyId) &&
		text(value.templateVersionId) &&
		finite(value._creationTime) &&
		finite(value.savedAt) &&
		validContractState(value)
	);
}

export function readContractState(value: unknown): ContractState | undefined {
	return validContractState(value) ? value : undefined;
}
export function readContractMetadata(value: unknown, id: string): Metadata | undefined {
	return validContractMetadata(value, id) ? value : undefined;
}

function point(value: unknown) {
	return object(value) && text(value.sourceKey) && finite(value.offset);
}
function range(value: unknown) {
	return object(value) && point(value.start) && point(value.end);
}
function sourceTarget(value: unknown) {
	return (
		object(value) &&
		((value.kind === 'text' && range(value.range)) ||
			(value.kind === 'boundary' && text(value.afterBlockKey)))
	);
}
function pattern(value: unknown) {
	return array(
		value,
		(part) =>
			object(part) &&
			(text(part.text) ||
				(finite(part.level) &&
					(part.case === undefined || part.case === 'upper' || part.case === 'lower') &&
					(part.minimumDigits === undefined || finite(part.minimumDigits))))
	);
}
function reference(value: Record<string, unknown>) {
	return (
		text(value.targetItemKey) &&
		(value.endTargetItemKey === undefined || text(value.endTargetItemKey)) &&
		object(value.display) &&
		pattern(value.display.start) &&
		(value.display.end === undefined || pattern(value.display.end)) &&
		(value.display.separator === undefined || text(value.display.separator))
	);
}
function inline(value: unknown) {
	return (
		object(value) &&
		text(value.sourceKey) &&
		((value.kind === 'text' && text(value.text)) ||
			(value.kind === 'reference' && reference(value)))
	);
}
function replacement(value: unknown) {
	return (
		object(value) &&
		(value.kind === 'paragraph-break' ||
			(value.kind === 'text' && text(value.text)) ||
			(value.kind === 'reference' && reference(value)))
	);
}
function numbering(value: unknown) {
	return (
		object(value) &&
		text(value.itemKey) &&
		text(value.sequenceKey) &&
		(value.parentItemKey === undefined || text(value.parentItemKey)) &&
		(value.start === undefined || finite(value.start)) &&
		pattern(value.labelPattern) &&
		(value.referencePattern === undefined || pattern(value.referencePattern)) &&
		(value.minimumDigits === undefined || finite(value.minimumDigits)) &&
		(value.alphabeticStyle === undefined ||
			value.alphabeticStyle === 'sequential' ||
			value.alphabeticStyle === 'repeated') &&
		(value.style === 'decimal' ||
			value.style === 'lower-alpha' ||
			value.style === 'lower-roman' ||
			value.style === 'upper-alpha' ||
			value.style === 'upper-roman')
	);
}
function block(value: unknown) {
	if (
		!object(value) ||
		!text(value.blockKey) ||
		!finite(value.order) ||
		(value.numbering !== undefined && !numbering(value.numbering))
	)
		return false;
	switch (value.kind) {
		case 'heading':
			return (
				text(value.anchor) &&
				(value.level === 1 || value.level === 2 || value.level === 3) &&
				array(value.content, inline)
			);
		case 'paragraph':
			return array(value.content, inline);
		case 'table':
			return (
				(value.variant === undefined || value.variant === 'signature') &&
				finite(value.headerRowCount) &&
				array(value.rows, (row) =>
					array(row, (cell) => object(cell) && array(cell.content, inline))
				)
			);
		default:
			return false;
	}
}
function instructions(value: unknown) {
	return (
		object(value) &&
		[
			'summary',
			'howToExplainToBuyers',
			'commonObjections',
			'negotiation',
			'changesNeedApproval'
		].every((key) => value[key] === undefined || text(value[key]))
	);
}
function item(value: unknown, companyId: string) {
	return (
		object(value) &&
		value.companyId === companyId &&
		text(value._id) &&
		finite(value._creationTime) &&
		natural(value.revision) &&
		object(value.trigger) &&
		text(value.trigger.id) &&
		sourceTarget(value.trigger.range) &&
		(value.instructions === undefined || instructions(value.instructions)) &&
		array(
			value.concessions,
			(concession) =>
				object(concession) &&
				text(concession.id) &&
				text(concession.description) &&
				(concession.tier === 'preferred' || concession.tier === 'rare') &&
				array(
					concession.changes,
					(change) =>
						object(change) && sourceTarget(change.range) && array(change.replacement, replacement),
					2
				)
		)
	);
}

// Immutable content is checked once for an exact object/company pair. A disk
// read creates a new object and must pass all checks before joining shared memory.
const validatedTemplates = new WeakMap<object, string>();
export function validTemplate(value: unknown, companyId: string): value is ContractSnapshot {
	if (!object(value)) return false;
	if (validatedTemplates.get(value) === companyId) return true;
	if (
		!natural(value.blockCount) ||
		!natural(value.itemCount) ||
		!Array.isArray(value.blocks) ||
		value.blockCount !== value.blocks.length ||
		!Array.isArray(value.items) ||
		value.itemCount !== value.items.length ||
		value.blockCount > MAX_CONTRACT_BLOCKS ||
		value.itemCount > MAX_PLAYBOOK_ITEMS
	)
		return false;
	if (
		!array(value.blocks, block, MAX_CONTRACT_BLOCKS) ||
		!array(value.items, (entry) => item(entry, companyId), MAX_PLAYBOOK_ITEMS)
	)
		return false;
	validatedTemplates.set(value, companyId);
	return true;
}
export function validSnapshot(value: unknown, id: string): value is ReadyContract {
	return (
		object(value) &&
		value.status === 'ready' &&
		value.id === id &&
		validContractMetadata(value.contract, id) &&
		validTemplate(value.snapshot, value.contract.companyId)
	);
}
