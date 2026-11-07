import { BinaryReader, BinaryWriter } from './binary';
import type { SourceIndex, StructuralBoundary } from './source-index';
import { numberSourceKey } from './source-model';
import {
	referenceFacts,
	type ReferenceFact,
	type ReferenceFacts,
	type ValidationBlock,
	type ValidationContainer,
	type ValidationSourceFacts,
	type ValidationUnit
} from './validation-source';

export const VALIDATION_CODEC_VERSION = 1;
export type CertifiedValidationFacts = { index: ValidationSourceFacts; references: ReferenceFacts };
export function encodeValidationFacts(index: SourceIndex): ArrayBuffer {
	const writer = new BinaryWriter(),
		references = referenceFacts(index);
	writer.uint(VALIDATION_CODEC_VERSION);
	writer.uint(index.orderedBlocks.length);
	for (const block of index.orderedBlocks) {
		writer.string(block.blockKey);
		writer.uint(block.kind === 'table' ? 1 : 0);
		// Each numbering key is encoded once. The generated number source key is derived,
		// avoiding a second copy of an arbitrarily long itemKey in compact source facts.
		writer.uint(block.numbering ? 1 : 0);
		if (block.numbering) {
			const key = block.numbering.itemKey,
				fact = references.get(key)!;
			writer.string(key);
			writer.string(fact.sequence);
			writer.uint(fact.parent === undefined ? 0 : 1);
			if (fact.parent !== undefined) writer.string(fact.parent);
			writer.uint(fact.depth);
			writer.uint(fact.numericMask);
		}
		const units = index.containers.get(block.blockKey)?.units ?? [];
		writer.uint(units.length);
		for (const unit of units) {
			writer.uint(unit.kind === 'text' ? 0 : unit.kind === 'reference' ? 1 : 2);
			if (unit.kind !== 'number') writer.string(unit.sourceKey);
			if (unit.kind === 'text') writer.uint(unit.length);
		}
	}
	return writer.finish();
}
export function decodeValidationFacts(bytes: ArrayBuffer): CertifiedValidationFacts {
	const reader = new BinaryReader(bytes);
	if (reader.uint() !== VALIDATION_CODEC_VERSION)
		throw new Error('Unsupported source validation format');
	const count = reader.uint();
	if (count < 1 || count > 4096) throw new Error('Invalid validation block count');
	const units: ValidationUnit[] = [],
		byKey = new Map<string, ValidationUnit>(),
		containers = new Map<string, ValidationContainer>();
	const orderedBlocks: ValidationBlock[] = [],
		blocks = new Map<string, ValidationBlock>(),
		blockOrdinals = new Map<string, number>();
	const structuralBoundaries = new Map<string, StructuralBoundary>(),
		references = new Map<string, ReferenceFact>();
	let position = 0,
		region = 0;
	for (let i = 0; i < count; i++) {
		const blockKey = reader.string(),
			kind = reader.uint();
		if (kind > 1 || blocks.has(blockKey)) throw new Error('Invalid validation block');
		const block: ValidationBlock = { blockKey, kind: kind ? 'table' : 'paragraph' };
		orderedBlocks.push(block);
		blocks.set(blockKey, block);
		blockOrdinals.set(blockKey, i);
		let itemKey: string | undefined;
		const hasNumber = reader.uint();
		if (hasNumber > 1 || (hasNumber && kind)) throw new Error('Invalid validation numbering');
		if (hasNumber) {
			itemKey = reader.string();
			const sequence = reader.string(),
				hasParent = reader.uint();
			if (hasParent > 1 || references.has(itemKey)) throw new Error('Invalid validation reference');
			const parent = hasParent ? reader.string() : undefined,
				depth = reader.uint(),
				numericMask = reader.uint();
			if (depth < 1 || depth > 9 || numericMask >= 1 << depth)
				throw new Error('Invalid validation numbering');
			references.set(itemKey, {
				ordinal: i,
				sequence,
				...(parent === undefined ? {} : { parent }),
				depth,
				numericMask
			});
		}
		const unitCount = reader.uint();
		if (unitCount > 8193 || (kind === 1 ? unitCount !== 0 : !unitCount))
			throw new Error('Invalid validation container');
		const local: ValidationUnit[] = [];
		for (let j = 0; j < unitCount; j++) {
			const unitKind = reader.uint();
			if (unitKind > 2 || (unitKind === 2 && (!itemKey || j !== 0)))
				throw new Error('Invalid validation source');
			const sourceKey = unitKind === 2 ? numberSourceKey(itemKey!) : reader.string(),
				length = unitKind === 0 ? reader.uint() : 1;
			if (byKey.has(sourceKey)) throw new Error('Invalid validation source');
			const unit: ValidationUnit = {
				sourceKey,
				kind: unitKind === 0 ? 'text' : unitKind === 1 ? 'reference' : 'number',
				length,
				blockKey,
				containerKey: blockKey,
				position
			};
			position += length;
			local.push(unit);
			units.push(unit);
			byKey.set(sourceKey, unit);
		}
		if (kind === 1) region++;
		else {
			containers.set(blockKey, { blockKey, containerKey: blockKey, region, units: local });
			position++;
		}
	}
	for (let i = 0; i < orderedBlocks.length; i++) {
		const before = orderedBlocks[i],
			after = orderedBlocks[i + 1];
		if (before.kind === 'table' || after?.kind === 'table') continue;
		structuralBoundaries.set(before.blockKey, {
			afterBlockKey: before.blockKey,
			...(after ? { nextBlockKey: after.blockKey } : {})
		});
	}
	reader.end();
	return {
		index: { units, byKey, containers, blocks, orderedBlocks, blockOrdinals, structuralBoundaries },
		references
	};
}
/** Certification verifies exact coordinates, lossless keys and references before enabling compact saves. */
export function certifyValidationFacts(index: SourceIndex) {
	const bytes = encodeValidationFacts(index),
		decoded = decodeValidationFacts(bytes),
		facts = decoded.index;
	const references = referenceFacts(index);
	const mismatch = () => {
		throw new Error('Source validation encoding did not preserve source coordinates');
	};
	if (
		index.orderedBlocks.length !== facts.orderedBlocks.length ||
		index.units.length !== facts.units.length ||
		index.structuralBoundaries.size !== facts.structuralBoundaries.size ||
		references.size !== decoded.references.size
	)
		mismatch();
	for (const [i, block] of index.orderedBlocks.entries())
		if (
			block.blockKey !== facts.orderedBlocks[i].blockKey ||
			block.kind !== facts.orderedBlocks[i].kind
		)
			mismatch();
	for (const [i, unit] of index.units.entries()) {
		const other = facts.units[i];
		if (
			unit.sourceKey !== other.sourceKey ||
			unit.kind !== other.kind ||
			unit.blockKey !== other.blockKey ||
			unit.containerKey !== other.containerKey ||
			unit.position !== other.position ||
			unit.length !== other.length
		)
			mismatch();
	}
	for (const [key, boundary] of index.structuralBoundaries) {
		const other = facts.structuralBoundaries.get(key);
		if (
			!other ||
			boundary.afterBlockKey !== other.afterBlockKey ||
			boundary.nextBlockKey !== other.nextBlockKey
		)
			mismatch();
	}
	for (const [key, fact] of references) {
		const other = decoded.references.get(key);
		if (
			!other ||
			fact.ordinal !== other.ordinal ||
			fact.sequence !== other.sequence ||
			fact.parent !== other.parent ||
			fact.depth !== other.depth ||
			fact.numericMask !== other.numericMask
		)
			mismatch();
	}
	return bytes;
}
