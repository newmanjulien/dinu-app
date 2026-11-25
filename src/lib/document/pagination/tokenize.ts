import { complete } from '$lib/document/iteration';
import type { ResolvedRun } from '$lib/document/model';
import type { InlineToken } from './types';

// The browser can wrap after an ASCII hyphen inside a word. Expose that boundary
// while retaining exact source slices/generated offsets; labels/references stay atomic.
const TEXT_CHUNK = /\r\n|[\r\n]|[^\s-]+-?[^\S\r\n]*|-[^\S\r\n]*|[^\S\r\n]+/gu;

function lineAnchor(token: Pick<InlineToken, 'annotations' | 'revision'>): InlineToken {
	return {
		value: '\u200b',
		generated: 'empty-hit-target',
		lineAnchor: true,
		...(token.annotations ? { annotations: token.annotations } : {}),
		...(token.revision ? { revision: token.revision } : {})
	};
}

export function tokenizeInline(runs: readonly ResolvedRun[]): InlineToken[] {
	return complete(iterateInlineTokens(runs));
}

export function* iterateInlineTokens(
	runs: readonly ResolvedRun[]
): Generator<undefined, InlineToken[]> {
	const tokens: InlineToken[] = [];
	let count = 0;
	for (const { text, ...metadata } of runs) {
		// Preserve deletion provenance as an invisible insertion boundary.
		if (!text.length && metadata.discussion && metadata.visualSource) {
			tokens.push({
				...metadata,
				value: '\u200b',
				lineAnchor: true,
				generated: 'empty-hit-target'
			});
			yield undefined;
			continue;
		}
		// Generated labels/references are atomic even if their displayed text changes length.
		if (
			metadata.sourceKind === 'number' ||
			metadata.sourceKind === 'reference' ||
			metadata.discussion?.atomic
		) {
			if (text) tokens.push({ ...metadata, value: text });
			yield undefined;
			continue;
		}
		for (const match of text.matchAll(TEXT_CHUNK)) {
			const value = match[0],
				offset = match.index;
			const source = metadata.source;
			const lineBreak = /[\r\n]/u.test(value);
			if (lineBreak) tokens.push(lineAnchor(metadata));
			tokens.push({
				...metadata,
				value,
				...(metadata.discussion
					? { discussion: { ...metadata.discussion, offset: metadata.discussion.offset + offset } }
					: {}),
				...(lineBreak ? { lineBreak: true } : {}),
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
	const last = tokens.at(-1);
	if (last?.lineBreak) tokens.push(lineAnchor(last));
	return tokens;
}
