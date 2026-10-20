import { PlaybookValidationError } from '../playbook/validation-error';
import type { BaselineBlock, ReplacementAtom } from './source-model';
import { buildSourceIndex } from './source-index';
import { validateStorageArrays } from './storage-limits';
import { numberAddresses, referenceText } from './numbering';
import { patternKey, validateNumberPattern } from './number-pattern';

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
	const items = new Map<string, { block: BaselineBlock; position: number }>();
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
	for (const [position, block] of blocks.entries()) {
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
				ancestor = items.get(ancestor)?.block.numbering?.parentItemKey;
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
			if (item.alphabeticStyle !== undefined && !item.style.includes('alpha'))
				throw new PlaybookValidationError('Invalid alphabetic numbering.');
			for (const pattern of [item.labelPattern, item.referencePattern])
				if (pattern !== undefined) validateNumberPattern(pattern, depth, true);

			if (items.has(item.itemKey) || block.kind === 'table')
				throw new PlaybookValidationError(`Invalid numbering item: ${item.itemKey}`);
			if (item.parentItemKey !== undefined) {
				key(item.parentItemKey, 'numbering parent');
				const parent = items.get(item.parentItemKey)?.block;
				if (!parent || (parent.kind === 'paragraph' && parent.optional))
					throw new PlaybookValidationError(
						`Missing, late or optional numbering parent: ${item.itemKey}`
					);
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
			items.set(item.itemKey, { block, position });
		}
		if (block.kind === 'heading') unique(anchors, block.anchor, 'heading anchor');
		if (
			block.kind === 'paragraph' &&
			block.optional &&
			(!item ||
				block.content.length !== 1 ||
				block.content[0].kind !== 'text' ||
				block.content[0].text !== '')
		)
			throw new PlaybookValidationError(`Invalid optional block: ${block.blockKey}`);
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
	const addresses = numberAddresses(blocks);
	function validateReference(ref: Reference): void {
		key(ref.targetItemKey, 'reference target');
		if (ref.endTargetItemKey !== undefined) key(ref.endTargetItemKey, 'reference end target');
		const start = items.get(ref.targetItemKey),
			end = ref.endTargetItemKey !== undefined ? items.get(ref.endTargetItemKey) : undefined;
		const optional = (entry: typeof start) =>
			entry?.block.kind === 'paragraph' && entry.block.optional;
		if (
			!start ||
			optional(start) ||
			(ref.endTargetItemKey !== undefined && (!end || optional(end)))
		)
			throw new PlaybookValidationError(`Unresolved reference: ${ref.targetItemKey}`);
		if (
			end &&
			(end.position <= start.position ||
				end.block.numbering!.sequenceKey !== start.block.numbering!.sequenceKey ||
				end.block.numbering!.parentItemKey !== start.block.numbering!.parentItemKey)
		)
			throw new PlaybookValidationError(`Invalid reference range: ${ref.targetItemKey}`);
		referenceText(ref, addresses);
	}
	for (const ref of references) validateReference(ref);
	return { index, validateReference };
}
