import type { SourceBlock } from '../document/model';
import type { Concession } from '../playbook/model';
import type { TemplateContent } from '../template/model';
import { MAX_DOCUMENT_BLOCKS, MAX_PLAYBOOK_ITEMS } from '../playbook/limits';
import {
	hasMeaningfulReplacement,
	hasRepItemContent,
	isNonBlankText,
	isValidPlaybookId,
	isValidSourceOffset,
	PLAYBOOK_INSTRUCTION_KEYS
} from '../playbook/item-content-predicates';
import type { ContractState, ReadyContract } from './saved';
import type { ContractWorkBlock } from './work-policy';
import { MAX_STORAGE_ARRAY_ENTRIES } from '../document/storage-limits';

// Compile-time exhaustive mirrors of Convex literal unions, with zero runtime validator imports.
const WORK_BLOCKS: Record<ContractWorkBlock, true> = {
	'association-required': true,
	'deal-unavailable': true
};
const HUBSPOT_AVAILABILITIES: Record<NonNullable<ContractState['hubspot']>['availability'], true> =
	{
		available: true,
		unavailable: true
	};
const CONCESSION_STATUSES: Record<ContractState['concessions'][number]['status'], true> = {
	pending: true,
	approved: true,
	rejected: true
};
const CONCESSION_TIERS: Record<Concession['tier'], true> = {
	preferred: true,
	rare: true
};
const PARAGRAPH_ROLES: Record<Extract<SourceBlock, { kind: 'paragraph' }>['role'], true> = {
	title: true,
	heading: true,
	body: true
};
const TABLE_VARIANTS: Record<
	NonNullable<Extract<SourceBlock, { kind: 'table' }>['variant']>,
	true
> = {
	signature: true
};
const NUMBERING_STYLES: Record<NonNullable<SourceBlock['numbering']>['style'], true> = {
	decimal: true,
	'lower-alpha': true,
	'lower-roman': true,
	'upper-alpha': true,
	'upper-roman': true
};
const ALPHABETIC_STYLES: Record<
	NonNullable<NonNullable<SourceBlock['numbering']>['alphabeticStyle']>,
	true
> = {
	sequential: true,
	repeated: true
};
const PATTERN_CASES: Record<
	NonNullable<
		Extract<
			NonNullable<SourceBlock['numbering']>['labelPattern'][number],
			{ level: number }
		>['case']
	>,
	true
> = {
	upper: true,
	lower: true
};
function hasEnumKey<K extends string>(table: Record<K, true>, value: unknown): value is K {
	return typeof value === 'string' && Object.hasOwn(table, value);
}

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
	for (const entry of value) if (!check(entry)) return false;
	return true;
}
function validReviewRequest(value: unknown) {
	return (
		value === undefined ||
		(object(value) &&
			natural(value.generation) &&
			text(value.deliveryId) &&
			text(value.requesterId) &&
			finite(value.requestedAt))
	);
}
function validReviewCompletion(value: unknown) {
	return (
		value === undefined ||
		(object(value) &&
			natural(value.generation) &&
			((value.kind === 'awaitingConfirmation' &&
				text(value.reviewerId) &&
				finite(value.decidedAt)) ||
				(value.kind === 'queued' && text(value.deliveryId))))
	);
}
function validReview(value: unknown) {
	return (
		object(value) &&
		natural(value.generation) &&
		validReviewRequest(value.request) &&
		validReviewCompletion(value.completion)
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
			hasEnumKey(HUBSPOT_AVAILABILITIES, value.availability))
	);
}
export function validContractState(value: unknown): value is ContractState {
	return (
		object(value) &&
		text(value.title) &&
		validReview(value.review) &&
		natural(value.stateRevision) &&
		natural(value.metadataRevision) &&
		validHubSpot(value.hubspot) &&
		(value.workBlock === undefined ||
			value.workBlock === null ||
			hasEnumKey(WORK_BLOCKS, value.workBlock)) &&
		(value.lastOperationId === null || text(value.lastOperationId)) &&
		array(
			value.concessions,
			(entry) =>
				object(entry) &&
				text(entry.itemId) &&
				text(entry.optionId) &&
				hasEnumKey(CONCESSION_STATUSES, entry.status) &&
				(entry.reviewedBy === undefined || text(entry.reviewedBy)) &&
				(entry.reviewedAt === undefined || finite(entry.reviewedAt)),
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
	return (
		object(value) &&
		text(value.sourceKey) &&
		typeof value.offset === 'number' &&
		isValidSourceOffset(value.offset)
	);
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
					(part.case === undefined || hasEnumKey(PATTERN_CASES, part.case)) &&
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
		(value.alphabeticStyle === undefined || hasEnumKey(ALPHABETIC_STYLES, value.alphabeticStyle)) &&
		hasEnumKey(NUMBERING_STYLES, value.style)
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
				hasEnumKey(PARAGRAPH_ROLES, value.role) &&
				(value.anchor === undefined || text(value.anchor)) &&
				value.level === undefined &&
				array(value.content, inline)
			);
		case 'table':
			return (
				value.numbering === undefined &&
				(value.variant === undefined || hasEnumKey(TABLE_VARIANTS, value.variant)) &&
				natural(value.headerRowCount) &&
				array(value.rows, (row) => array(row, (cell) => typeof cell === 'string'))
			);
		default:
			return false;
	}
}
function instructions(value: unknown): value is Record<string, string | undefined> {
	return (
		object(value) &&
		PLAYBOOK_INSTRUCTION_KEYS.every(
			(key) => value[key] === undefined || (text(value[key]) && isNonBlankText(value[key]))
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
		isValidPlaybookId(value.trigger.id) &&
		sourceTarget(value.trigger.target) &&
		(value.audience === 'buyer'
			? object(value.trigger.target) &&
				value.trigger.target.kind === 'text' &&
				text(value.explanation) &&
				isNonBlankText(value.explanation)
			: value.audience === 'rep' &&
				object(value.approvalPolicy) &&
				(value.approvalPolicy.kind === 'none' ||
					(value.approvalPolicy.kind === 'required' &&
						text(value.approvalPolicy.instructions) &&
						isNonBlankText(value.approvalPolicy.instructions))) &&
				instructions(value.instructions) &&
				array(
					value.concessions,
					(concession) =>
						object(concession) &&
						text(concession.id) &&
						isValidPlaybookId(concession.id) &&
						text(concession.description) &&
						isNonBlankText(concession.description) &&
						hasEnumKey(CONCESSION_TIERS, concession.tier) &&
						array(
							concession.changes,
							(change) =>
								object(change) &&
								sourceTarget(change.target) &&
								array(change.replacement, replacement) &&
								((change.target as { kind: string }).kind !== 'boundary' ||
									hasMeaningfulReplacement(
										change.replacement as Parameters<typeof hasMeaningfulReplacement>[0]
									)),
							2
						) &&
						(concession.changes as unknown[]).length > 0
				) &&
				hasRepItemContent({
					instructions: value.instructions,
					approvalPolicy: value.approvalPolicy as { kind: 'none' | 'required' },
					concessions: value.concessions as unknown[]
				}))
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
