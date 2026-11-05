import { complete } from '$lib/contract/iteration';
import type { ResolvedRun } from '$lib/contract/model';
import type { InlineToken } from './types';

// The browser can wrap after an ASCII hyphen inside a word. Expose that boundary
// while retaining exact source slices/generated offsets; labels/references stay atomic.
const TEXT_CHUNK = /[^\s-]+-?\s*|-\s*|\s+/gu;

export function tokenizeInline(runs: readonly ResolvedRun[]): InlineToken[] {
	return complete(iterateInlineTokens(runs));
}

export function* iterateInlineTokens(
	runs: readonly ResolvedRun[]
): Generator<undefined, InlineToken[]> {
	const tokens: InlineToken[] = [];
	let count = 0;
	for (const { text, ...metadata } of runs) {
		// Generated labels/references are atomic even if their displayed text changes length.
		if (metadata.sourceKind === 'number' || metadata.sourceKind === 'reference') {
			if (text) tokens.push({ ...metadata, value: text });
			yield undefined;
			continue;
		}
		for (const match of text.matchAll(TEXT_CHUNK)) {
			const value = match[0],
				offset = match.index;
			const source = metadata.source;
			tokens.push({
				...metadata,
				value,
				...(metadata.generatedOffset !== undefined
					? { generatedOffset: metadata.generatedOffset + offset }
					: {}),
				...(source && metadata.sourceKind === 'text'
					? {
							source: {
								start: { ...source.start, offset: source.start.offset + offset },
								end: { ...source.end, offset: source.start.offset + offset + value.length }
							}
						}
					: {})
			});
			if (++count % 128 === 0) yield undefined;
		}
		yield undefined;
	}
	return tokens;
}
