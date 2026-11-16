import type { ApprovedContractDocument } from './document-preview';
import type { TemplateContent } from '../template/model';
import { MAX_DOCUMENT_BLOCKS, MAX_PLAYBOOK_ITEMS } from '../playbook/limits';
import type { ContractState, ReadyContract } from './saved';
import { MAX_STORAGE_ARRAY_ENTRIES } from '../document/storage-limits';

// Disk data is unknown even though network data is validated by Convex. These
// checks describe the persisted domain, without interpreting a schema language
// or importing server validators into the browser. Semantic source/geometry
// validation stays with template saving and compilation.
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
function validCompletion(value: unknown) {
	return (
		value === undefined ||
		(object(value) &&
			Object.keys(value).length === 2 &&
			text(value.reviewIdentity) &&
			object(value.completion) &&
			((Object.keys(value.completion).length === 2 &&
				value.completion.kind === 'awaitingConfirmation' &&
				text(value.completion.reviewerId)) ||
				(Object.keys(value.completion).length === 2 &&
					value.completion.kind === 'queued' &&
					text(value.completion.deliveryId))))
	);
}
function validReviewGroup(value: unknown) {
	return (
		object(value) &&
		text(value.identity) &&
		Object.keys(value).every((key) => key === 'identity' || key === 'completion') &&
		validCompletion(value.completion)
	);
}
function validReviews(value: unknown) {
	return (
		object(value) &&
		Object.keys(value).length === 2 &&
		validReviewGroup(value.playbook) &&
		validReviewGroup(value.buyerLink)
	);
}
function validHubSpot(value: unknown) {
	return (
		value === undefined ||
		(object(value) &&
			text(value.connectionId) &&
			text(value.accountId) &&
			text(value.dealId) &&
			natural(value.generation) &&
			value.generation > 0 &&
			(value.availability === 'available' || value.availability === 'unavailable'))
	);
}
export function validContractState(value: unknown): value is ContractState {
	return (
		object(value) &&
		text(value.title) &&
		text(value.documentId) &&
		validReviews(value.reviews) &&
		natural(value.documentRevision) &&
		natural(value.stateRevision) &&
		validHubSpot(value.hubspot) &&
		(value.workBlock === undefined ||
			value.workBlock === null ||
			value.workBlock === 'association-required' ||
			value.workBlock === 'deal-unavailable') &&
		(value.lastOperationId === null || text(value.lastOperationId)) &&
		array(
			value.playbook,
			(entry) =>
				object(entry) &&
				text(entry.itemId) &&
				(entry.currentChangeId === null || text(entry.currentChangeId)) &&
				(entry.appliedChangeId === null || text(entry.appliedChangeId)) &&
				(entry.currentOptionId === null || text(entry.currentOptionId)) &&
				(entry.appliedOptionId === null || text(entry.appliedOptionId)) &&
				(entry.decisionId === null || text(entry.decisionId)) &&
				(entry.status === 'pending' || entry.status === 'approved' || entry.status === 'rejected'),
			MAX_PLAYBOOK_ITEMS
		)
	);
}

type Metadata = ReadyContract['contract'];
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
			(Object.hasOwn(part, 'text')
				? Object.keys(part).every((key) => key === 'text') && text(part.text)
				: Object.keys(part).every((key) => ['level', 'case', 'minimumDigits'].includes(key)) &&
					finite(part.level) &&
					(part.case === undefined || part.case === 'upper' || part.case === 'lower') &&
					(part.minimumDigits === undefined || finite(part.minimumDigits)))
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
		(value.continueSequence === undefined || value.continueSequence === false) &&
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
	if (value.kind === 'table' && (value.role !== undefined || value.anchor !== undefined))
		return false;
	switch (value.kind) {
		case 'paragraph':
			return (
				(value.role === 'title' || value.role === 'heading' || value.role === 'body') &&
				(value.anchor === undefined || text(value.anchor)) &&
				value.level === undefined &&
				array(value.content, inline)
			);
		case 'table':
			return (
				value.numbering === undefined &&
				(value.variant === undefined || value.variant === 'signature') &&
				natural(value.headerRowCount) &&
				array(value.rows, (row) => array(row, (cell) => typeof cell === 'string'))
			);
		default:
			return false;
	}
}
function instructions(value: unknown) {
	return (
		object(value) &&
		['summary', 'howToExplainToBuyers', 'commonObjections', 'negotiation'].every(
			(key) => value[key] === undefined || text(value[key])
		)
	);
}
function item(value: unknown, companyId: string) {
	return (
		object(value) &&
		value.companyId === companyId &&
		text(value._id) &&
		finite(value._creationTime) &&
		natural(value.contentRevision) &&
		object(value.trigger) &&
		text(value.trigger.id) &&
		sourceTarget(value.trigger.target) &&
		(value.audience === 'buyer'
			? object(value.trigger.target) &&
				value.trigger.target.kind === 'text' &&
				text(value.explanation) &&
				Boolean(value.explanation.trim())
			: value.audience === 'rep' &&
				object(value.approvalPolicy) &&
				(value.approvalPolicy.kind === 'none' ||
					(value.approvalPolicy.kind === 'required' &&
						text(value.approvalPolicy.instructions) &&
						Boolean(value.approvalPolicy.instructions.trim()))) &&
				sourceTarget(value.trigger.target) &&
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
								object(change) &&
								sourceTarget(change.target) &&
								array(change.replacement, replacement),
							2
						)
				))
	);
}

// Immutable content is checked once for an exact object/company pair. A disk
// read creates a new object and must pass all checks before joining shared memory.
const validatedTemplates = new WeakMap<object, string>();
export function validTemplate(value: unknown, companyId: string): value is TemplateContent {
	if (!object(value)) return false;
	if (validatedTemplates.get(value) === companyId) return true;
	if (
		!natural(value.blockCount) ||
		!natural(value.itemCount) ||
		!Array.isArray(value.blocks) ||
		value.blockCount !== value.blocks.length ||
		!Array.isArray(value.items) ||
		value.itemCount !== value.items.length ||
		value.blockCount > MAX_DOCUMENT_BLOCKS ||
		value.itemCount > MAX_PLAYBOOK_ITEMS
	)
		return false;
	if (
		!array(value.blocks, block, MAX_DOCUMENT_BLOCKS) ||
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

/** Immutable approved transport remains disposable and cannot authorize access or commands. */
export function validApprovedDocument(
	value: unknown,
	documentId: string
): value is ApprovedContractDocument {
	if (
		!object(value) ||
		value.documentId !== documentId ||
		!natural(value.documentRevision) ||
		!text(value.displayIdentity) ||
		!object(value.document)
	)
		return false;
	const doc = value.document;
	const interval = (value: unknown) =>
		object(value) &&
		text(value.sourceKey) &&
		natural(value.start) &&
		natural(value.end) &&
		value.end >= value.start;
	return (
		array(doc.blocks, block, MAX_DOCUMENT_BLOCKS) &&
		array(doc.pieceGroups, (group) =>
			array(
				group,
				(piece) =>
					object(piece) &&
					text(piece.sourceKey) &&
					interval(piece.origin) &&
					(piece.originalRangeGroups === undefined ||
						array(piece.originalRangeGroups, (ranges) => array(ranges, interval)))
			)
		) &&
		array(doc.aliasGroups, (group) =>
			array(group, (pair) => Array.isArray(pair) && pair.length === 2 && pair.every(text))
		) &&
		array(doc.removedBlockGroups, (group) => array(group, text)) &&
		Array.isArray(doc.blocks) &&
		Array.isArray(doc.pieceGroups) &&
		doc.blocks.length === doc.pieceGroups.length &&
		array(value.hiddenItemIds, text) &&
		array(
			value.projectedTargets,
			(entry) =>
				object(entry) &&
				text(entry.itemId) &&
				sourceTarget(entry.trigger) &&
				array(
					entry.choices,
					(choice) => object(choice) && text(choice.id) && array(choice.targets, sourceTarget)
				)
		)
	);
}
