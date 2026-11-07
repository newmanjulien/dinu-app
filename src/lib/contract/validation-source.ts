import { PlaybookValidationError } from '../playbook/validation-error';
import { validateNumberPattern } from './number-pattern';
import type { ReplacementAtom } from './source-model';
import type { SourceIndex, SourceUnit, StructuralBoundary } from './source-index';

export type ValidationUnit = Omit<SourceUnit, 'displayText'>;
export type ValidationContainer = {
	readonly blockKey: string;
	readonly containerKey: string;
	readonly region: number;
	readonly units: readonly ValidationUnit[];
};
export type ValidationBlock = { readonly blockKey: string; readonly kind: 'paragraph' | 'table' };
/** Explicit source-coordinate semantics shared by full and certified compact sources. */
export interface ValidationSourceFacts {
	readonly units: readonly ValidationUnit[];
	readonly byKey: ReadonlyMap<string, ValidationUnit>;
	readonly containers: ReadonlyMap<string, ValidationContainer>;
	readonly blocks: ReadonlyMap<string, ValidationBlock>;
	readonly orderedBlocks: readonly ValidationBlock[];
	readonly blockOrdinals: ReadonlyMap<string, number>;
	readonly structuralBoundaries: ReadonlyMap<string, StructuralBoundary>;
}
export type ReferenceFact = {
	ordinal: number;
	sequence: string;
	parent?: string;
	depth: number;
	numericMask: number;
};
export type ReferenceFacts = ReadonlyMap<string, ReferenceFact>;
export function referenceFacts(index: SourceIndex): ReferenceFacts {
	return new Map(
		[...index.numberingItems].map(([key, block]) => {
			const address = index.addresses.get(key)!;
			return [
				key,
				{
					ordinal: index.blockOrdinals.get(block.blockKey)!,
					sequence: block.numbering!.sequenceKey,
					...(block.numbering!.parentItemKey === undefined
						? {}
						: { parent: block.numbering!.parentItemKey }),
					depth: address.tokens.length,
					numericMask: address.tokens.reduce(
						(mask, token, i) => mask | (/^\d+$/u.test(token) ? 1 << i : 0),
						0
					)
				}
			];
		})
	);
}
export function validateReferenceFacts(
	facts: ReferenceFacts,
	ref: Extract<ReplacementAtom, { kind: 'reference' }>
) {
	for (const key of [ref.targetItemKey, ref.endTargetItemKey])
		if (key !== undefined && (!key.trim() || key !== key.trim()))
			throw new PlaybookValidationError(`Invalid reference target: ${key}`);
	const start = facts.get(ref.targetItemKey),
		end = ref.endTargetItemKey === undefined ? undefined : facts.get(ref.endTargetItemKey);
	if (!start || (ref.endTargetItemKey !== undefined && !end))
		throw new PlaybookValidationError(`Unresolved reference: ${ref.targetItemKey}`);
	if (
		end &&
		!(end.ordinal > start.ordinal && end.sequence === start.sequence && end.parent === start.parent)
	)
		throw new PlaybookValidationError(`Invalid reference range: ${ref.targetItemKey}`);
	if (
		Boolean(ref.display.end) !== Boolean(ref.endTargetItemKey) ||
		Boolean(ref.display.separator) !== Boolean(ref.endTargetItemKey)
	)
		throw new PlaybookValidationError('Invalid reference display.');
	if (ref.display.separator && !/^[ \t]*[-–—][ \t]*$/u.test(ref.display.separator))
		throw new PlaybookValidationError('Invalid reference range separator.');
	for (const [pattern, target] of [
		[ref.display.start, start],
		[ref.display.end, end]
	] as const) {
		if (!target) continue;
		if (!pattern) throw new PlaybookValidationError('Missing reference display.');
		validateNumberPattern(pattern, target.depth, true);
		for (const part of pattern)
			if (
				'level' in part &&
				part.minimumDigits !== undefined &&
				!(target.numericMask & (1 << (part.level - 1)))
			)
				throw new PlaybookValidationError('Invalid decimal reference.');
	}
}
