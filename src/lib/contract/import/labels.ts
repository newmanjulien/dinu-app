import { tokenPosition } from '../number-token';
import type { NumberPatternPart } from '../number-pattern';
/** The same token grammar is used for typed labels and reference lookup. */
export function labelTokens(label: string): { value: string; index: number }[] {
	const prefix = label.match(/^(?:Article|Section|Clause|Part)\s+/iu)?.[0].length ?? 0;
	return [...label.slice(prefix).matchAll(/\d+|[A-Za-z]+/gu)].map((m) => ({
		value: m[0],
		index: prefix + m.index
	}));
}

export function addressKey(label: string, folded = false): string {
	return labelTokens(label)
		.map(({ value }) =>
			/^\d+$/u.test(value) ? value.replace(/^0+(?=\d)/u, '') : folded ? value.toLowerCase() : value
		)
		.join('/');
}

/** Number-like tokens exclude mixed-case titles and alphabetic words beyond the counter bound. */
export function numberToken(value: string): boolean {
	return (['decimal', 'roman', 'repeated', 'sequential'] as const).some(
		(kind) => tokenPosition(value, kind) > 0
	);
}

/** Obvious decimal syntax remains recognizable even outside the supported counter bound. */
export const numberSyntax = (value: string) => /^\d+$/u.test(value) || numberToken(value);

export function typedLabel(text: string): RegExpMatchArray | null {
	const match = text.match(
		/^\s*((?:(?:Article|Section|Clause|Part)\s+(?:\d+(?:\.\d+)*|[A-Za-z]+)|\d+(?:\.\d+)*|[A-Za-z]+[.)]|[A-Za-z]+(?=[([])|\([A-Za-z0-9]+\)|\[[A-Za-z0-9]+\])(?:[ \t]*(?:\([A-Za-z0-9]+\)|\[[A-Za-z0-9]+\]))*[.):]?)[ \t]+/iu
	);
	if (
		match &&
		/^(?:Article|Section|Clause|Part)\s/iu.test(match[1]) &&
		/^(?:of|in|under|above|below|applies|provides|requires)\b/iu.test(text.slice(match[0].length))
	)
		return null;
	return match && labelTokens(match[1]).every(({ value }) => numberSyntax(value)) ? match : null;
}

export function labelPattern(label: string): NumberPatternPart[] {
	const parts: NumberPatternPart[] = [];
	let cursor = 0;
	for (const [i, part] of labelTokens(label).entries()) {
		if (part.index > cursor) parts.push({ text: label.slice(cursor, part.index) });
		parts.push({ level: i + 1 });
		cursor = part.index + part.value.length;
	}
	if (cursor < label.length) parts.push({ text: label.slice(cursor) });
	return parts;
}
