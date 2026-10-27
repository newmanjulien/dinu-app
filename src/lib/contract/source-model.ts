import type { Infer } from 'convex/values';
import type * as validators from '../../convex/sourceValidators';

export type SourcePoint = Infer<typeof validators.sourcePoint>;
export type SourceRange = Infer<typeof validators.sourceRange>;
export type InlineSource = Infer<typeof validators.inlineSource>;
export type BaselineBlock = Infer<typeof validators.baselineBlock>;
export type ReplacementAtom = Infer<typeof validators.replacementAtom>;

/** Reserved, virtual identity; never persisted as an inline atom. Offsets are 0/1. */
export const numberSourceKey = (itemKey: string): string => `number:${itemKey}`;

export function sameSourceRange(a: SourceRange, b: SourceRange): boolean {
	return (
		a.start.sourceKey === b.start.sourceKey &&
		a.start.offset === b.start.offset &&
		a.end.sourceKey === b.end.sourceKey &&
		a.end.offset === b.end.offset
	);
}
