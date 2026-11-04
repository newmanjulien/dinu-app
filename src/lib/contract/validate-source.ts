import { PlaybookValidationError } from '../playbook/validation-error';
import type { BaselineBlock, ReplacementAtom } from './source-model';
import { buildSourceIndex } from './source-index';
import { validateStorageArrays } from './storage-limits';
import { referenceText } from './numbering';
import { patternKey, validateNumberPattern } from './number-pattern';
import { canReferenceRange, normalizeReferenceAddress } from './reference-catalog';

const MAX_BLOCK_BYTES = 900_000; // Leave room for Convex metadata and version wrappers.

type Reference = Extract<ReplacementAtom, { kind: 'reference' }>;

function key(value: string, label: string): void {
	if (!value?.trim() || value !== value.trim())
		throw new PlaybookValidationError(`Invalid ${label}: ${value}`);
}
function unique(seen: Set<string>, value: string, label: string): void {
	key(value, label);
	if (seen.has(value)) throw new PlaybookValidationError(`Duplicate ${label}: ${value}`);
	seen.add(value);
}

/** Immutable source validation, independent of the Playbook and authoring workflow. */
export function validateBaseline(blocks: readonly BaselineBlock[]) {
	validateStorageArrays(blocks);
	if (!blocks.length) throw new PlaybookValidationError('Contract has no blocks');
	const anchors = new Set<string>();
	const items = new Map<string, BaselineBlock>();
	const sequences = new Map<
		string,
		{
			parent?: string;
			style: string;
			pattern?: string;
			reference?: string;
			minimumDigits?: number;
			alphabeticStyle?: string;
		}
	>();
	const references: Extract<ReplacementAtom, { kind: 'reference' }>[] = [];
	for (const block of blocks) {
		if (new TextEncoder().encode(JSON.stringify(block)).length > MAX_BLOCK_BYTES)
			throw new PlaybookValidationError(`Contract block exceeds storage size: ${block.blockKey}`);
		const item = block.numbering;
		if (item) {
			key(item.itemKey, 'numbering item');
			key(item.sequenceKey, 'numbering sequence');
			if (
				item.start !== undefined &&
				(!Number.isSafeInteger(item.start) || item.start < 1 || item.start > 10000)
			)
				throw new PlaybookValidationError('Numbering starts must be between 1 and 10000.');
			let depth = 1;
			let ancestor = item.parentItemKey;
			while (ancestor && depth <= 9) {
				depth++;
				ancestor = items.get(ancestor)?.numbering?.parentItemKey;
			}
			if (depth > 9) throw new PlaybookValidationError('Numbering supports up to nine levels.');
			if (
				item.minimumDigits !== undefined &&
				(item.style !== 'decimal' ||
					!Number.isSafeInteger(item.minimumDigits) ||
					item.minimumDigits < 1 ||
					item.minimumDigits > 9)
			)
				throw new PlaybookValidationError('Invalid decimal padding.');
			if (item.style.includes('alpha') ? !item.alphabeticStyle : item.alphabeticStyle !== undefined)
				throw new PlaybookValidationError('Invalid alphabetic numbering.');
			validateNumberPattern(item.labelPattern, depth, true);
			if (item.referencePattern) validateNumberPattern(item.referencePattern, depth, true);

			if (items.has(item.itemKey) || block.kind === 'table')
				throw new PlaybookValidationError(`Invalid numbering item: ${item.itemKey}`);
			if (item.parentItemKey !== undefined) {
				key(item.parentItemKey, 'numbering parent');
				const parent = items.get(item.parentItemKey);
				if (!parent)
					throw new PlaybookValidationError(`Missing or late numbering parent: ${item.itemKey}`);
			}
			const sequence = sequences.get(item.sequenceKey);
			if (
				sequence &&
				(sequence.parent !== item.parentItemKey ||
					sequence.style !== item.style ||
					sequence.pattern !== patternKey(item.labelPattern) ||
					sequence.reference !== patternKey(item.referencePattern) ||
					sequence.minimumDigits !== item.minimumDigits ||
					sequence.alphabeticStyle !== item.alphabeticStyle)
			)
				throw new PlaybookValidationError(`Mixed numbering sequence: ${item.sequenceKey}`);
			sequences.set(item.sequenceKey, {
				parent: item.parentItemKey,
				style: item.style,
				pattern: patternKey(item.labelPattern),
				reference: patternKey(item.referencePattern),
				minimumDigits: item.minimumDigits,
				alphabeticStyle: item.alphabeticStyle
			});
			items.set(item.itemKey, block);
		}
		if (block.kind === 'heading') unique(anchors, block.anchor, 'heading anchor');
		if (block.kind === 'table') {
			if (
				!block.rows.length ||
				!block.rows[0].length ||
				block.rows.some((row) => row.length !== block.rows[0].length) ||
				!Number.isSafeInteger(block.headerRowCount) ||
				block.headerRowCount < 0 ||
				block.headerRowCount > block.rows.length
			)
				throw new PlaybookValidationError(`Invalid table: ${block.blockKey}`);
		}
		function inspect(content: readonly import('./source-model').InlineSource[]) {
			for (const atom of content) if (atom.kind === 'reference') references.push(atom);
		}
		if (block.kind === 'table') {
			for (const row of block.rows) {
				for (const cell of row) inspect(cell.content);
			}
		} else inspect(block.content);
	}
	const index = buildSourceIndex(blocks);
	const referenceAddresses = new Map<string, string>();
	for (const [itemKey, address] of index.addresses) {
		if (!address.address) continue;
		const normalized = normalizeReferenceAddress(address.address);
		const previous = referenceAddresses.get(normalized);
		if (previous && previous !== itemKey)
			throw new PlaybookValidationError(`Ambiguous reference address: ${address.address}`);
		referenceAddresses.set(normalized, itemKey);
	}
	function validateReference(ref: Reference): void {
		key(ref.targetItemKey, 'reference target');
		if (ref.endTargetItemKey !== undefined) key(ref.endTargetItemKey, 'reference end target');
		const start = index.numberingItems.get(ref.targetItemKey),
			end =
				ref.endTargetItemKey !== undefined
					? index.numberingItems.get(ref.endTargetItemKey)
					: undefined;
		if (!start || (ref.endTargetItemKey !== undefined && !end))
			throw new PlaybookValidationError(`Unresolved reference: ${ref.targetItemKey}`);
		if (end && !canReferenceRange(index, ref.targetItemKey, ref.endTargetItemKey!))
			throw new PlaybookValidationError(`Invalid reference range: ${ref.targetItemKey}`);
		referenceText(ref, index.addresses);
	}
	for (const ref of references) validateReference(ref);
	return { index, validateReference };
}
