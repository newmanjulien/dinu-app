import type { DiscussionAnchor, DiscussionPoint } from './validators';
import type { ResolvedRun } from '../document/model';
import { runOffset, runPoint } from './anchors';
import { readSelectedDomEnvelope } from '../document/selection/dom-selection';

function tokenRun(token: HTMLElement): ResolvedRun | null {
	try {
		const source =
			token.dataset.sourceStartKey && token.dataset.sourceEndKey
				? {
						start: {
							sourceKey: token.dataset.sourceStartKey,
							offset: Number(token.dataset.sourceStartOffset)
						},
						end: {
							sourceKey: token.dataset.sourceEndKey,
							offset: Number(token.dataset.sourceEndOffset)
						}
					}
				: undefined;
		const discussion =
			token.dataset.discussionOrigin && token.dataset.discussionOffset !== undefined
				? {
						origin: JSON.parse(token.dataset.discussionOrigin) as NonNullable<
							ResolvedRun['generatedOrigin']
						>,
						offset: Number(token.dataset.discussionOffset),
						...(token.dataset.discussionAtomic === 'true' ? { atomic: true as const } : {})
					}
				: undefined;
		return {
			text: token.textContent ?? '',
			source,
			discussion,
			sourceKind: token.dataset.sourceKind as ResolvedRun['sourceKind'],
			generated: token.dataset.generated as ResolvedRun['generated']
		};
	} catch {
		return null;
	}
}

function concessionKey(origin: { itemId: string; concessionId: string; changeIndex: number }) {
	return `${origin.itemId}:${origin.concessionId}:${origin.changeIndex}`;
}

type TokenEntry = { token: HTMLElement; run: ResolvedRun; paragraph: number };
export type DiscussionDomIndex = {
	entries: TokenEntry[];
	sources: Map<string, number[]>;
	concessions: Map<string, number[]>;
};

export function indexDiscussionDom(root: HTMLElement): DiscussionDomIndex {
	const entries: TokenEntry[] = [],
		sources = new Map<string, number[]>(),
		concessions = new Map<string, number[]>();
	const paragraphKeys = new Map<string, number>();
	for (const token of root.querySelectorAll<HTMLElement>('[data-document-token]')) {
		if (
			token.closest('[aria-hidden="true"],del,[data-revision="removed"],table') ||
			['number', 'separator', 'empty-hit-target'].includes(token.dataset.generated ?? '') ||
			!token.textContent
		)
			continue;
		const run = tokenRun(token);
		if (!run) continue;
		const blockKey = token.closest<HTMLElement>('[data-block-key]')?.dataset.blockKey ?? '';
		let paragraph = paragraphKeys.get(blockKey);
		if (paragraph === undefined) {
			paragraph = paragraphKeys.size;
			paragraphKeys.set(blockKey, paragraph);
		}
		const index = entries.length;
		entries.push({ token, run, paragraph });
		if (run.discussion) {
			const key = concessionKey(run.discussion.origin),
				list = concessions.get(key) ?? [];
			list.push(index);
			concessions.set(key, list);
		} else if (!run.generated && run.source) {
			const key = run.source.start.sourceKey,
				list = sources.get(key) ?? [];
			list.push(index);
			sources.set(key, list);
		}
	}
	return { entries, sources, concessions };
}

export function captureDiscussionAnchor(
	root: HTMLElement,
	range: Range,
	entries = indexDiscussionDom(root).entries
): DiscussionAnchor | null {
	if (!root.contains(range.startContainer) || !root.contains(range.endContainer) || range.collapsed)
		return null;
	// Validate the whole native selection, including text outside indexed paragraph tokens.
	// Otherwise table text can silently disappear from the anchor and target another passage.
	const eligible = new Set(entries.map(({ token }) => token));
	const ancestor = range.commonAncestorContainer;
	const scope =
		ancestor.nodeType === Node.ELEMENT_NODE ? (ancestor as Element) : ancestor.parentElement;
	if (
		!scope ||
		scope.closest('table') ||
		[...scope.querySelectorAll('table')].some((table) => range.intersectsNode(table)) ||
		!readSelectedDomEnvelope(root, range, (text) => {
			const parent = text.parentElement;
			if (!parent) return false;
			if (parent.closest('[aria-hidden="true"],del,[data-revision="removed"]')) return true;
			const token = parent.closest<HTMLElement>('[data-document-token]');
			if (
				token &&
				['number', 'separator', 'empty-hit-target'].includes(token.dataset.generated ?? '')
			)
				return true;
			return Boolean(token && eligible.has(token));
		})
	)
		return null;
	let start: DiscussionAnchor['start'] | null = null,
		end: DiscussionAnchor['end'] | null = null,
		quote = '',
		previous: number | undefined;
	for (const { token, run, paragraph } of entries) {
		if (!range.intersectsNode(token)) continue;
		let from = 0,
			to = run.text.length;
		if (token.contains(range.startContainer)) {
			const before = range.cloneRange();
			before.selectNodeContents(token);
			before.setEnd(range.startContainer, range.startOffset);
			from = before.toString().length;
		}
		if (token.contains(range.endContainer)) {
			const before = range.cloneRange();
			before.selectNodeContents(token);
			before.setEnd(range.endContainer, range.endOffset);
			to = before.toString().length;
		}
		if (from >= to) continue;
		const a = runPoint(run, from),
			b = runPoint(run, to);
		if (!a || !b) return null;
		if (start && paragraph !== previous) quote += '\n'.repeat(paragraph - previous!);
		start ??= a;
		end = b;
		quote += run.text.slice(from, to);
		previous = paragraph;
	}
	return start && end && quote.trim() && quote.length <= 20_000 ? { start, end, quote } : null;
}

/** Verify that a captured range matches the saved anchor quote, tolerating cross-reference
 * and clause-number renumbering (e.g. "Section 5" -> "Section 6", "2." -> "3.") in O(N) time. */
function matchesQuoteWithReferences(
	slice: readonly TokenEntry[],
	startOffset: number,
	endOffset: number,
	savedQuote: string
): boolean {
	const literals: string[] = [''];
	let hasRenumberable = false;
	let previousParagraph: number | undefined;
	for (let i = 0; i < slice.length; i++) {
		const { run, paragraph } = slice[i];
		const from = i === 0 ? startOffset : 0;
		const to = i === slice.length - 1 ? endOffset : run.text.length;
		if (from >= to) continue;
		if (previousParagraph !== undefined && paragraph !== previousParagraph) {
			literals[literals.length - 1] += '\n'.repeat(paragraph - previousParagraph);
		}
		previousParagraph = paragraph;
		if (run.sourceKind === 'reference' || run.sourceKind === 'number' || run.discussion?.atomic) {
			hasRenumberable = true;
			literals.push('');
		} else {
			literals[literals.length - 1] += run.text.slice(from, to);
		}
	}
	if (!hasRenumberable) return false;
	const first = literals[0];
	const last = literals[literals.length - 1];
	if (!savedQuote.startsWith(first) || !savedQuote.endsWith(last)) return false;
	let pos = first.length;
	const limit = savedQuote.length - last.length;
	if (pos >= limit) return false;

	// Each gap between literals matches [^\n]+ (at least one non-newline char).
	// If a middle literal contains '\n' at offset `segNl`, it can match only at `lineEnd - segNl`;
	// otherwise the earliest match >= pos + 1 on the current line strictly dominates later matches.
	let nextNl = savedQuote.indexOf('\n', pos);
	for (let i = 1; i < literals.length - 1; i++) {
		const segment = literals[i];
		if (nextNl >= 0 && nextNl < pos) nextNl = savedQuote.indexOf('\n', pos);
		const lineEnd = nextNl < 0 || nextNl > limit ? limit : nextNl;
		if (!segment) {
			if (pos + 1 >= lineEnd) return false;
			pos += 1;
			continue;
		}
		const segNl = segment.indexOf('\n');
		if (segNl >= 0) {
			if (lineEnd === limit || savedQuote[lineEnd] !== '\n') return false;
			const found = lineEnd - segNl;
			if (found < pos + 1 || found + segment.length > limit) return false;
			if (!savedQuote.startsWith(segment, found)) return false;
			pos = found + segment.length;
		} else {
			const found = savedQuote.indexOf(segment, pos + 1);
			if (found < 0 || found + segment.length > lineEnd) return false;
			pos = found + segment.length;
		}
	}
	if (pos >= limit) return false;
	if (nextNl >= 0 && nextNl < pos) nextNl = savedQuote.indexOf('\n', pos);
	return nextNl < 0 || nextNl >= limit;
}

export function discussionDomRange(
	root: HTMLElement,
	anchor: DiscussionAnchor,
	index = indexDiscussionDom(root)
): Range | null {
	const endpoint = (point: DiscussionPoint, ending: boolean) => {
		const candidates =
			point.kind === 'source'
				? index.sources.get(point.point.sourceKey)
				: index.concessions.get(concessionKey(point));
		for (const i of candidates ?? []) {
			const entry = index.entries[i],
				offset = runOffset(entry.run, point);
			if (
				offset === null ||
				(!ending && offset === entry.run.text.length) ||
				entry.token.childNodes.length !== 1 ||
				entry.token.firstChild?.nodeType !== Node.TEXT_NODE
			)
				continue;
			return { i, node: entry.token.firstChild, offset };
		}
		return null;
	};
	const start = endpoint(anchor.start, false),
		end = endpoint(anchor.end, true);
	if (!start || !end || end.i < start.i) return null;
	const range = document.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset);
	const slice = index.entries.slice(start.i, end.i + 1);
	const captured = captureDiscussionAnchor(root, range, slice);
	if (!captured) return null;
	if (captured.quote === anchor.quote) return range;
	return matchesQuoteWithReferences(slice, start.offset, end.offset, anchor.quote) ? range : null;
}
