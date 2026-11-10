import type { DeepReadonly } from '../immutable';
import type { NumberPatternPart } from './number-pattern';
import type { ReplacementAtom } from './source-model';

type ReplacementContentAtom =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'reference' }
	| { readonly kind: 'paragraph-break' };

export type ReplacementAtomValue = DeepReadonly<ReplacementAtom>;
type PatternPart = Readonly<NumberPatternPart>;

function samePattern(a: readonly PatternPart[], b: readonly PatternPart[]) {
	return (
		a.length === b.length &&
		a.every((part, index) => {
			const other = b[index]!;
			if ('text' in part) return 'text' in other && part.text === other.text;
			return (
				!('text' in other) &&
				part.level === other.level &&
				part.case === other.case &&
				part.minimumDigits === other.minimumDigits
			);
		})
	);
}

export function sameReplacementAtom(a: ReplacementAtomValue, b: ReplacementAtomValue): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === 'paragraph-break') return true;
	if (a.kind === 'text') return b.kind === 'text' && a.text === b.text;
	return (
		b.kind === 'reference' &&
		a.targetItemKey === b.targetItemKey &&
		a.endTargetItemKey === b.endTargetItemKey &&
		a.display.separator === b.display.separator &&
		samePattern(a.display.start, b.display.start) &&
		((a.display.end === undefined && b.display.end === undefined) ||
			(a.display.end !== undefined &&
				b.display.end !== undefined &&
				samePattern(a.display.end, b.display.end)))
	);
}

export function sameReplacementAtoms(
	a: readonly ReplacementAtomValue[],
	b: readonly ReplacementAtomValue[]
): boolean {
	return (
		a === b ||
		(a.length === b.length && a.every((atom, index) => sameReplacementAtom(atom, b[index]!)))
	);
}

/** Paragraph breaks and whitespace change layout but never constitute authored concession content. */
export function hasMeaningfulReplacement(atoms: readonly ReplacementContentAtom[]) {
	return atoms.some(
		(atom) => atom.kind === 'reference' || (atom.kind === 'text' && atom.text.trim().length > 0)
	);
}
