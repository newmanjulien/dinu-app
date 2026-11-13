import type { DiscussionAnchor } from './validators';
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
		return {
			text: token.textContent ?? '',
			sourceOrigin: token.dataset.sourceOrigin ? JSON.parse(token.dataset.sourceOrigin) : undefined,
			source,
			sourceKind: token.dataset.sourceKind as ResolvedRun['sourceKind'],
			generated: token.dataset.generated as ResolvedRun['generated']
		};
	} catch {
		return null;
	}
}
type TokenEntry = { token: HTMLElement; run: ResolvedRun; paragraph: number };
export type DiscussionDomIndex = {
	entries: TokenEntry[];
	sources: Map<string, number[]>;
};
export function indexDiscussionDom(root: HTMLElement): DiscussionDomIndex {
	const entries: TokenEntry[] = [],
		sources = new Map<string, number[]>();
	const paragraphKeys = new Map<string, number>();
	for (const block of root.querySelectorAll<HTMLElement>('[data-block-key]')) {
		if (block.tagName === 'TABLE' || block.hasAttribute('data-discussion-removed')) continue;
		const key = block.dataset.blockKey!;
		if (!paragraphKeys.has(key)) paragraphKeys.set(key, paragraphKeys.size);
	}
	for (const token of root.querySelectorAll<HTMLElement>('[data-document-token]')) {
		if (
			token.closest(
				'[aria-hidden="true"],del,[data-revision="removed"],[data-discussion-removed],table'
			) ||
			['number', 'separator', 'empty-hit-target'].includes(token.dataset.generated ?? '') ||
			!token.textContent
		)
			continue;
		const run = tokenRun(token);
		if (!run) continue;
		const index = entries.length;
		entries.push({
			token,
			run,
			paragraph:
				paragraphKeys.get(token.closest<HTMLElement>('[data-block-key]')?.dataset.blockKey ?? '') ??
				0
		});
		if (run.source) {
			const key = (run.sourceOrigin ?? run.source).start.sourceKey,
				list = sources.get(key) ?? [];
			list.push(index);
			sources.set(key, list);
		}
	}
	return { entries, sources };
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
			if (
				parent.closest(
					'[aria-hidden="true"],del,[data-revision="removed"],[data-discussion-removed]'
				)
			)
				return true;
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
export function discussionDomRange(
	root: HTMLElement,
	anchor: DiscussionAnchor,
	index = indexDiscussionDom(root)
): Range | null {
	const endpoint = (point: DiscussionAnchor['start'], ending: boolean) => {
		const candidates = index.sources.get(point.point.sourceKey);
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
	return captureDiscussionAnchor(root, range, index.entries.slice(start.i, end.i + 1))?.quote ===
		anchor.quote
		? range
		: null;
}
