import type { Infer } from 'convex/values';
import type * as validators from '../../convex/sourceValidators';

export type SourcePoint = Infer<typeof validators.sourcePoint>;
export type SourceRange = Infer<typeof validators.sourceRange>;
/** A text target owns a real range of immutable source text. */
export type TextSourceTarget = { readonly kind: 'text'; readonly range: SourceRange };
/** A boundary target owns the structural edge immediately after one source block. */
export type BoundarySourceTarget = { readonly kind: 'boundary'; readonly afterBlockKey: string };
export type SourceTarget = TextSourceTarget | BoundarySourceTarget;
export type InlineSource = Infer<typeof validators.inlineSource>;
export type BaselineBlock = Infer<typeof validators.baselineBlock>;
export type ReplacementAtom = Infer<typeof validators.replacementAtom>;
export type ReplacementInline = Exclude<ReplacementAtom, { kind: 'paragraph-break' }>;

/** Reserved, virtual identity; never persisted as an inline atom. Offsets are 0/1. */
export const numberSourceKey = (itemKey: string): string => `number:${itemKey}`;

export const textTarget = (range: SourceRange): TextSourceTarget => ({ kind: 'text', range });

export function isTextTarget(target: SourceTarget): target is TextSourceTarget {
	return target.kind === 'text';
}

export function sameSourceRange(a: SourceRange, b: SourceRange): boolean {
	return (
		a.start.sourceKey === b.start.sourceKey &&
		a.start.offset === b.start.offset &&
		a.end.sourceKey === b.end.sourceKey &&
		a.end.offset === b.end.offset
	);
}

export function sameSourceTarget(a: SourceTarget, b: SourceTarget): boolean {
	return (
		a.kind === b.kind &&
		(a.kind === 'boundary'
			? a.afterBlockKey === (b as BoundarySourceTarget).afterBlockKey
			: sameSourceRange(a.range, (b as TextSourceTarget).range))
	);
}
