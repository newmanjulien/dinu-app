import type { InlineSource } from './source-model';

/** Stable field order; explicit false is retained because table headers have defaults. */
export function canonicalMarks(marks: InlineSource['marks']): InlineSource['marks'] {
	if (marks?.bold === undefined && marks?.italic === undefined) return undefined;
	return {
		...(marks?.bold !== undefined ? { bold: marks.bold } : {}),
		...(marks?.italic !== undefined ? { italic: marks.italic } : {})
	};
}
export function equalMarks(a: InlineSource['marks'], b: InlineSource['marks']): boolean {
	return a?.bold === b?.bold && a?.italic === b?.italic;
}
