import { PlaybookValidationError } from '../playbook/validation-error';
import type { BaselineBlock, InlineSource, SourcePoint } from './source-model';
import { numberSourceKey } from './source-model';
import { iterateNumberAddresses, referenceText, type Address } from './numbering';

export interface SourceUnit {
	readonly sourceKey: string;
	readonly kind: InlineSource['kind'] | 'number';
	readonly containerKey: string;
	readonly blockKey: string;
	readonly inTable: boolean;
	readonly position: number;
	/** UTF-16 code units for text (same as DOM offsets), 1 for atomic units. */
	readonly length: number;
	readonly displayText: string;
}
export interface SourceContainer {
	readonly containerKey: string;
	readonly blockKey: string;
	readonly inTable: boolean;
	readonly units: readonly SourceUnit[];
}
export interface SourceIndex {
	readonly units: readonly SourceUnit[];
	readonly byKey: ReadonlyMap<string, SourceUnit>;
	readonly containers: ReadonlyMap<string, SourceContainer>;
	readonly blocks: ReadonlyMap<string, BaselineBlock>;
	readonly orderedBlocks: readonly BaselineBlock[];
	readonly blockOrdinals: ReadonlyMap<string, number>;
	readonly numberingItems: ReadonlyMap<string, BaselineBlock>;
	/** Baseline numbering only; composed numbering and merge aliases are separate. */
	readonly addresses: ReadonlyMap<string, Address>;
	/** Selectable document boundaries. They are never source units or source containers. */
	readonly structuralBoundaries: ReadonlyMap<string, StructuralBoundary>;
}
export interface StructuralBoundary {
	/** The boundary is the trailing edge of this real source block. */
	readonly afterBlockKey: string;
	/** The next baseline block, when the boundary is internal rather than document-final. */
	readonly nextBlockKey?: string;
}
/** Copies display/coordinate data; generated display changes never change source coordinates. */
export function buildSourceIndex(blocks: readonly BaselineBlock[]): SourceIndex {
	const iterator = iterateSourceIndex(blocks);
	let next = iterator.next();
	while (!next.done) next = iterator.next();
	return next.value;
}

export function* iterateSourceIndex(
	blocks: readonly BaselineBlock[]
): Generator<undefined, SourceIndex> {
	const addresses = yield* iterateNumberAddresses(blocks);
	const units: SourceUnit[] = [];
	const byKey = new Map<string, SourceUnit>();
	const containers = new Map<string, SourceContainer>();
	const blockMap = new Map<string, BaselineBlock>();
	const orderedBlocks: BaselineBlock[] = [];
	const blockOrdinals = new Map<string, number>();
	const numberingItems = new Map<string, BaselineBlock>();
	const structuralBoundaries = new Map<string, StructuralBoundary>();
	let position = 0;
	let previousOrder = -1;
	function* container(
		block: BaselineBlock,
		containerKey: string,
		content: readonly InlineSource[],
		inTable: boolean
	) {
		const local: SourceUnit[] = [];
		function add(sourceKey: string, kind: SourceUnit['kind'], length: number, displayText: string) {
			if (!sourceKey.trim() || sourceKey !== sourceKey.trim() || byKey.has(sourceKey))
				throw new PlaybookValidationError(`Invalid or duplicate source: ${sourceKey}`);
			const unit = Object.freeze({
				sourceKey,
				kind,
				length,
				displayText,
				containerKey,
				blockKey: block.blockKey,
				inTable,
				position
			});
			units.push(unit);
			local.push(unit);
			byKey.set(sourceKey, unit);
			position += length;
		}
		if (!inTable && block.numbering)
			add(
				numberSourceKey(block.numbering.itemKey),
				'number',
				1,
				addresses.get(block.numbering.itemKey)?.label ?? ''
			);
		for (const atom of content) {
			yield undefined;
			if (atom.sourceKey.startsWith('number:') || atom.sourceKey.startsWith('gap:'))
				throw new PlaybookValidationError(`Reserved source namespace: ${atom.sourceKey}`);
			add(
				atom.sourceKey,
				atom.kind,
				atom.kind === 'text' ? atom.text.length : 1,
				atom.kind === 'text' ? atom.text : referenceText(atom, addresses)
			);
		}
		if (!local.length)
			throw new PlaybookValidationError(
				`Container needs a persisted empty text anchor: ${containerKey}`
			);
		if (containers.has(containerKey))
			throw new PlaybookValidationError(`Duplicate container: ${containerKey}`);
		containers.set(
			containerKey,
			Object.freeze({
				containerKey,
				blockKey: block.blockKey,
				inTable,
				units: Object.freeze(local)
			})
		);
		position++; // Structural boundaries are distinct even for two empty containers.
	}
	for (const block of blocks) {
		if (
			!block.blockKey.trim() ||
			block.blockKey.startsWith('gap:') ||
			block.blockKey.startsWith('insert:') ||
			block.blockKey !== block.blockKey.trim() ||
			blockMap.has(block.blockKey)
		)
			throw new PlaybookValidationError(`Invalid or duplicate block: ${block.blockKey}`);
		if (!Number.isSafeInteger(block.order) || block.order <= previousOrder)
			throw new PlaybookValidationError(`Invalid block order: ${block.blockKey}`);
		previousOrder = block.order;
		blockOrdinals.set(block.blockKey, orderedBlocks.length);
		orderedBlocks.push(block);
		blockMap.set(block.blockKey, block);
		if (block.numbering) numberingItems.set(block.numbering.itemKey, block);
		if (block.kind === 'table') {
			for (const [r, row] of block.rows.entries())
				for (const [c, cell] of row.entries()) {
					yield* container(block, `${block.blockKey}/cell/${r}/${c}`, cell.content, true);
					yield undefined;
				}
		} else yield* container(block, block.blockKey, block.content, false);
		yield undefined;
	}
	// Structural boundaries are metadata, not zero-length source text. In particular they never
	// enter `units`, `byKey`, or `containers`, so text algorithms cannot mistake one for content.
	for (let i = 0; i <= blocks.length; i++) {
		const before = blocks[i - 1],
			after = blocks[i];
		// The first paragraph has no leading document margin to select. Every slot is anchored
		// to a real trailing margin on its preceding paragraph or heading.
		if (!before) continue;
		if (before?.kind === 'table' || after?.kind === 'table') continue;
		if (before?.kind !== 'paragraph' && after?.kind !== 'paragraph') continue;
		structuralBoundaries.set(
			before.blockKey,
			Object.freeze({
				afterBlockKey: before.blockKey,
				...(after ? { nextBlockKey: after.blockKey } : {})
			})
		);
		yield undefined;
	}
	return {
		units: Object.freeze(units),
		byKey,
		containers,
		blocks: blockMap,
		orderedBlocks: Object.freeze(orderedBlocks),
		blockOrdinals,
		numberingItems,
		addresses,
		structuralBoundaries
	};
}
export function resolvePoint(index: SourceIndex, point: SourcePoint): SourceUnit {
	const unit = index.byKey.get(point.sourceKey);
	if (
		!unit ||
		!Number.isSafeInteger(point.offset) ||
		point.offset < 0 ||
		point.offset > unit.length
	)
		throw new PlaybookValidationError(`Invalid source point: ${point.sourceKey}@${point.offset}`);
	return unit;
}
export function pointPosition(index: SourceIndex, point: SourcePoint): number {
	return resolvePoint(index, point).position + point.offset;
}
