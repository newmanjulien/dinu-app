import { PlaybookValidationError } from '../playbook/validation-error';

export type NumberPatternPart =
	{ text: string } | { level: number; case?: 'upper' | 'lower'; minimumDigits?: number };
export type NumberPattern = NumberPatternPart[];

export function validateNumberPattern(pattern: NumberPattern, depth = 9, requireLeaf = false) {
	const parts = pattern;
	let length = 0,
		leaf = false;
	if (!parts.length || parts.length > 80)
		throw new PlaybookValidationError('Unsupported numbering pattern.');
	for (const part of parts) {
		if ('text' in part) {
			if (!part.text || /[^ A-Za-z0-9.()[\]{}:;,–—-]/u.test(part.text))
				throw new PlaybookValidationError('Unsupported numbering punctuation.');
			length += part.text.length;
		} else {
			if (
				!Number.isSafeInteger(part.level) ||
				part.level < 1 ||
				part.level > depth ||
				(part.case !== undefined && part.case !== 'upper' && part.case !== 'lower') ||
				(part.minimumDigits !== undefined &&
					(!Number.isSafeInteger(part.minimumDigits) ||
						part.minimumDigits < 1 ||
						part.minimumDigits > 9)) ||
				(part.case !== undefined && part.minimumDigits !== undefined)
			)
				throw new PlaybookValidationError('Invalid numbering counter.');
			length += 2;
			leaf ||= part.level === depth;
		}
	}
	if (length > 80 || (requireLeaf && !leaf))
		throw new PlaybookValidationError('Invalid numbering pattern.');
	return parts;
}

export function formatNumberPattern(pattern: NumberPattern, values: readonly string[]): string {
	return validateNumberPattern(pattern, values.length)
		.map((part) => {
			if ('text' in part) return part.text;
			const value = values[part.level - 1];
			if (part.case === 'upper') return value.toUpperCase();
			if (part.case === 'lower') return value.toLowerCase();
			if (part.minimumDigits !== undefined) {
				if (!/^\d+$/u.test(value)) throw new PlaybookValidationError('Invalid decimal reference.');
				return String(Number(value)).padStart(part.minimumDigits, '0');
			}
			return value;
		})
		.join('');
}

/** Word only defines %1…%9. Everything after those two characters is literal. */
export function wordNumberPattern(text: string): NumberPatternPart[] {
	const parts: NumberPatternPart[] = [];
	let cursor = 0;
	for (const match of text.matchAll(/%([1-9])/gu)) {
		if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index) });
		parts.push({ level: Number(match[1]) });
		cursor = match.index + 2;
	}
	if (cursor < text.length) parts.push({ text: text.slice(cursor) });
	return parts;
}

export function shiftNumberPattern(pattern: NumberPattern, offset: number): NumberPatternPart[] {
	return pattern.map((part) =>
		'text' in part ? { ...part } : { ...part, level: part.level + offset }
	);
}

export function addressPattern(pattern: NumberPattern): NumberPatternPart[] {
	const parts = pattern.map((part) => ({ ...part }));
	const last = parts.at(-1);
	if (last && 'text' in last) {
		last.text = last.text.replace(/[.\s]+$/u, '');
		if (!last.text) parts.pop();
	}
	return parts;
}

/** Select semantic fields in a stable order, excluding editor metadata. */
export function canonicalNumberPattern(pattern: readonly NumberPatternPart[]): NumberPatternPart[] {
	return pattern.map((part) =>
		'text' in part
			? { text: part.text }
			: {
					level: part.level,
					...(part.case !== undefined ? { case: part.case } : {}),
					...(part.minimumDigits !== undefined ? { minimumDigits: part.minimumDigits } : {})
				}
	);
}

export const patternKey = (pattern: NumberPattern | undefined) =>
	pattern === undefined ? undefined : JSON.stringify(canonicalNumberPattern(pattern));
