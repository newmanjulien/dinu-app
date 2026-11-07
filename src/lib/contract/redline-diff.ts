/** References compare by identity, independently of their current displayed number. */
export interface RedlineToken {
	key: string;
	text: string;
}
export interface RedlineDiffPart {
	kind: 'equal' | 'delete' | 'insert';
	sourceStart: number;
	sourceEnd: number;
	replacementStart: number;
	replacementEnd: number;
}
const MAX_LCS_CELLS = 65_536;
const MAX_DIFF_PARTS = 128;
const MAX_ANCHOR_DEPTH = 16;
const MIN_READABLE_RETENTION = 0.4;

export function* iterateRedlineTextTokens(text: string): Generator<undefined, RedlineToken[]> {
	const tokens: RedlineToken[] = [];
	for (const match of text.matchAll(
		/\s+|[\p{L}\p{N}\p{M}]+(?:['’\-][\p{L}\p{N}\p{M}]+)*|[^\s\p{L}\p{N}\p{M}]/gu
	)) {
		tokens.push({ key: `text:${match[0]}`, text: match[0] });
		if (tokens.length % 128 === 0) yield undefined;
	}
	return tokens;
}
function characters(text: string): number {
	return text.match(/[\p{L}\p{N}\p{M}\p{S}]/gu)?.length ?? 0;
}
function strongAnchor(tokens: readonly RedlineToken[]): boolean {
	if (tokens.some((token) => !token.key.startsWith('text:'))) return true;
	const words =
		tokens
			.map((token) => token.text)
			.join('')
			.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
	return (
		words.some((word) => characters(word) >= 10) ||
		(words.length >= 2 && words.reduce((n, word) => n + characters(word), 0) >= 8)
	);
}
/** Unique tokens in increasing order anchor long passages without quadratic work. */
function* uniqueAnchors(
	a: readonly RedlineToken[],
	b: readonly RedlineToken[],
	aStart: number,
	aEnd: number,
	bStart: number,
	bEnd: number
): Generator<undefined, [number, number][]> {
	function* positions(
		tokens: readonly RedlineToken[],
		start: number,
		end: number
	): Generator<undefined, Map<string, number>> {
		const result = new Map<string, number>();
		for (let i = start; i < end; i++) {
			if (i % 128 === 0) yield undefined;
			const token = tokens[i];
			if (token.text.trim()) result.set(token.key, result.has(token.key) ? -1 : i);
		}
		return result;
	}
	const source = yield* positions(a, aStart, aEnd);
	const replacement = yield* positions(b, bStart, bEnd);
	const pairs: [number, number][] = [];
	for (const [key, i] of source) {
		if (i % 128 === 0) yield undefined;
		const j = replacement.get(key);
		if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j]);
	}
	const tails: number[] = [],
		parents: number[] = [];
	for (let i = 0; i < pairs.length; i++) {
		if (i % 128 === 0) yield undefined;
		let low = 0,
			high = tails.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (pairs[tails[mid]][1] < pairs[i][1]) low = mid + 1;
			else high = mid;
		}
		parents[i] = low ? tails[low - 1] : -1;
		tails[low] = i;
	}
	const result: [number, number][] = [];
	for (let i = tails.at(-1) ?? -1; i >= 0; i = parents[i]) result.push(pairs[i]);
	return result.reverse();
}
/** Bounded presentation alignment. null retains conventional whole-range redlining. */
export function* iterateRedlineDiff(
	a: readonly RedlineToken[],
	b: readonly RedlineToken[]
): Generator<undefined, readonly RedlineDiffPart[] | null> {
	const candidate: RedlineDiffPart[] = [];
	let remainingCells = MAX_LCS_CELLS;
	function append(part: RedlineDiffPart, output = candidate) {
		if (part.sourceStart === part.sourceEnd && part.replacementStart === part.replacementEnd)
			return;
		const last = output.at(-1);
		if (
			last?.kind === part.kind &&
			last.sourceEnd === part.sourceStart &&
			last.replacementEnd === part.replacementStart
		) {
			last.sourceEnd = part.sourceEnd;
			last.replacementEnd = part.replacementEnd;
		} else output.push({ ...part });
	}
	function gap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
		append({
			kind: 'delete',
			sourceStart: aStart,
			sourceEnd: aEnd,
			replacementStart: bStart,
			replacementEnd: bStart
		});
		append({
			kind: 'insert',
			sourceStart: aEnd,
			sourceEnd: aEnd,
			replacementStart: bStart,
			replacementEnd: bEnd
		});
	}
	function* align(
		aStart: number,
		aEnd: number,
		bStart: number,
		bEnd: number,
		depth: number
	): Generator<undefined> {
		const prefixA = aStart,
			prefixB = bStart;
		while (aStart < aEnd && bStart < bEnd && a[aStart].key === b[bStart].key) {
			aStart++;
			bStart++;
			if (aStart % 128 === 0) yield undefined;
		}
		append({
			kind: 'equal',
			sourceStart: prefixA,
			sourceEnd: aStart,
			replacementStart: prefixB,
			replacementEnd: bStart
		});
		const suffixA = aEnd,
			suffixB = bEnd;
		while (aEnd > aStart && bEnd > bStart && a[aEnd - 1].key === b[bEnd - 1].key) {
			aEnd--;
			bEnd--;
			if (aEnd % 128 === 0) yield undefined;
		}
		const n = aEnd - aStart,
			m = bEnd - bStart,
			cells = (n + 1) * (m + 1);
		if (n && m && cells <= remainingCells) {
			remainingCells -= cells;
			const width = m + 1,
				lcs = new Uint32Array(cells);
			// Prefer substantive text to incidental matches of repeated spaces/articles.
			for (let i = n - 1; i >= 0; i--) {
				const weight = Math.max(1, characters(a[aStart + i].text));
				for (let j = m - 1; j >= 0; j--) {
					if (j % 128 === 0) yield undefined;
					lcs[i * width + j] =
						a[aStart + i].key === b[bStart + j].key
							? weight + lcs[(i + 1) * width + j + 1]
							: Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
				}
			}
			let i = 0,
				j = 0,
				sourceGap = aStart,
				replacementGap = bStart;
			while (i < n && j < m) {
				if ((i + j) % 128 === 0) yield undefined;
				if (a[aStart + i].key === b[bStart + j].key) {
					gap(sourceGap, aStart + i, replacementGap, bStart + j);
					append({
						kind: 'equal',
						sourceStart: aStart + i,
						sourceEnd: aStart + i + 1,
						replacementStart: bStart + j,
						replacementEnd: bStart + j + 1
					});
					sourceGap = aStart + ++i;
					replacementGap = bStart + ++j;
				} else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) i++;
				else j++;
			}
			gap(sourceGap, aEnd, replacementGap, bEnd);
		} else {
			const anchors =
				n && m && depth < MAX_ANCHOR_DEPTH
					? yield* uniqueAnchors(a, b, aStart, aEnd, bStart, bEnd)
					: [];
			let sourceGap = aStart,
				replacementGap = bStart;
			for (const [i, j] of anchors) {
				yield* align(sourceGap, i, replacementGap, j, depth + 1);
				append({
					kind: 'equal',
					sourceStart: i,
					sourceEnd: i + 1,
					replacementStart: j,
					replacementEnd: j + 1
				});
				sourceGap = i + 1;
				replacementGap = j + 1;
			}
			gap(sourceGap, aEnd, replacementGap, bEnd);
		}
		append({
			kind: 'equal',
			sourceStart: aEnd,
			sourceEnd: suffixA,
			replacementStart: bEnd,
			replacementEnd: suffixB
		});
	}
	yield* align(0, a.length, 0, b.length, 0);
	const before = a.map((token) => token.text).join(''),
		after = b.map((token) => token.text).join('');
	const words = (text: string) => text.match(/[\p{L}\p{N}\p{M}\p{S}]+/gu) ?? [];
	const sourceWords = words(before),
		replacementWords = words(after);
	const nonlexical =
		sourceWords.length > 0 &&
		sourceWords.length === replacementWords.length &&
		sourceWords.every((word, i) => word === replacementWords[i]);
	const parts: RedlineDiffPart[] = [];
	let pending: RedlineDiffPart | undefined;
	function flush() {
		if (!pending) return;
		append({ ...pending, kind: 'delete', replacementEnd: pending.replacementStart }, parts);
		append({ ...pending, kind: 'insert', sourceStart: pending.sourceEnd }, parts);
		pending = undefined;
	}
	const oneWord = (tokens: readonly RedlineToken[]) =>
		tokens.filter((token) => !token.key.startsWith('text:') || /[\p{L}\p{N}]/u.test(token.text))
			.length === 1;
	function wordSubstitution(removed?: RedlineDiffPart, added?: RedlineDiffPart): boolean {
		return (
			removed?.kind === 'delete' &&
			added?.kind === 'insert' &&
			oneWord(a.slice(removed.sourceStart, removed.sourceEnd)) &&
			oneWord(b.slice(added.replacementStart, added.replacementEnd))
		);
	}
	for (const [i, part] of candidate.entries()) {
		yield undefined;
		const unchanged = part.kind === 'equal' ? a.slice(part.sourceStart, part.sourceEnd) : [];
		if (
			part.kind === 'equal' &&
			(nonlexical ||
				i === 0 ||
				i === candidate.length - 1 ||
				strongAnchor(unchanged) ||
				// A genuine word between two word substitutions is useful context,
				// even when too short to anchor a larger rewrite by itself.
				(unchanged.some((token) => /[\p{L}\p{N}]/u.test(token.text)) &&
					wordSubstitution(candidate[i - 2], candidate[i - 1]) &&
					wordSubstitution(candidate[i + 1], candidate[i + 2])))
		) {
			flush();
			append(part, parts);
		} else if (pending) {
			pending.sourceEnd = part.sourceEnd;
			pending.replacementEnd = part.replacementEnd;
		} else pending = { ...part };
	}
	flush();
	if (parts.length > MAX_DIFF_PARTS) return null;
	const weight = characters(before) + characters(after);
	const retained = parts
		.filter((part) => part.kind === 'equal')
		.reduce(
			(n, part) =>
				n +
				characters(
					a
						.slice(part.sourceStart, part.sourceEnd)
						.map((t) => t.text)
						.join('')
				) +
				characters(
					b
						.slice(part.replacementStart, part.replacementEnd)
						.map((t) => t.text)
						.join('')
				),
			0
		);
	if (
		!nonlexical &&
		(weight ? retained / weight < MIN_READABLE_RETENTION : before.length + after.length > 128)
	)
		return null;
	// Check both coordinate streams before exposing any presentation result.
	let sourceEnd = 0,
		replacementEnd = 0;
	for (const part of parts) {
		if (part.sourceStart !== sourceEnd || part.replacementStart !== replacementEnd) return null;
		sourceEnd = part.sourceEnd;
		replacementEnd = part.replacementEnd;
	}
	return sourceEnd === a.length && replacementEnd === b.length ? parts : null;
}
