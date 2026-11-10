import type { DiscussionAnchor } from './validators';
import type { ResolvedRun } from '../document/model';
import { runOffset, runPoint } from './anchors';
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
			discussion: token.dataset.discussion ? JSON.parse(token.dataset.discussion) : undefined,
			source,
			sourceKind: token.dataset.sourceKind as ResolvedRun['sourceKind'],
			generated: token.dataset.generated as ResolvedRun['generated'],
			generatedOffset:
				token.dataset.generatedOffset === undefined
					? undefined
					: Number(token.dataset.generatedOffset),
			generatedOrigin: token.dataset.generatedOrigin
				? JSON.parse(token.dataset.generatedOrigin)
				: undefined
		};
	} catch {
		return null;
	}
}
type TokenEntry = { token: HTMLElement; run: ResolvedRun; paragraph: number };
export type DiscussionDomIndex = {
	entries: TokenEntry[];
	sources: Map<string, number[]>;
	origins: Map<string, number[]>;
};
const originKey = (origin: NonNullable<ResolvedRun['generatedOrigin']>) =>
	JSON.stringify([origin.itemId, origin.concessionId, origin.changeIndex]);
export function indexDiscussionDom(root: HTMLElement): DiscussionDomIndex {
	const entries: TokenEntry[] = [],
		sources = new Map<string, number[]>(),
		origins = new Map<string, number[]>();
	const paragraphKeys = new Map<string, number>();
	for (const block of root.querySelectorAll<HTMLElement>('[data-block-key]')) {
		if (block.tagName === 'TABLE' || block.hasAttribute('data-discussion-removed')) continue;
		const key = block.dataset.blockKey!;
		if (!paragraphKeys.has(key)) paragraphKeys.set(key, paragraphKeys.size);
	}
	for (const token of root.querySelectorAll<HTMLElement>('[data-document-token]')) {
		if (
			token.closest('[aria-hidden="true"],del,[data-revision="removed"],table') ||
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
			const key = run.source.start.sourceKey,
				list = sources.get(key) ?? [];
			list.push(index);
			sources.set(key, list);
		}
		if (run.discussion?.origin ?? run.generatedOrigin) {
			const key = originKey((run.discussion?.origin ?? run.generatedOrigin)!),
				list = origins.get(key) ?? [];
			list.push(index);
			origins.set(key, list);
		}
	}
	return { entries, sources, origins };
}
export function captureDiscussionAnchor(
	root: HTMLElement,
	range: Range,
	entries = indexDiscussionDom(root).entries
): DiscussionAnchor | null {
	if (!root.contains(range.startContainer) || !root.contains(range.endContainer) || range.collapsed)
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
		const candidates =
			point.kind === 'source'
				? index.sources.get(point.point.sourceKey)
				: index.origins.get(originKey(point.origin));
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
