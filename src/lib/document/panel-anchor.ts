import { measureStructuralBoundaryTarget } from './highlights/geometry';
import { validateTarget } from './ranges';
import { pointPosition } from './source-index';
import { isTextTarget, sameSourceTarget, type SourceTarget } from './source-model';
import type { RenderSnapshot } from './runtime/types';
import {
	boundaryTargetBreakGroups,
	legacyTextNavigationGroups,
	presentationToken,
	type BreakGroup,
	type TextOccurrence
} from './selection/selection-model';
import { isSelectionPageMounted } from './selection/selection-surface';

type Candidate = {
	occurrence: TextOccurrence;
	priority: number;
	position: number;
	offset: number;
};

function tokenBounds(element: HTMLElement, offset: number, text: boolean): DOMRect | null {
	if (element.closest('[aria-hidden="true"], [data-document-control]')) return null;
	if (text) {
		const node = element.firstChild;
		if (node?.nodeType !== Node.TEXT_NODE || !node.textContent?.length) return null;
		const from = Math.max(0, Math.min(offset, node.textContent.length - 1));
		const range = element.ownerDocument.createRange();
		range.setStart(node, from);
		range.setEnd(node, from + 1);
		for (const bounds of range.getClientRects()) if (bounds.height || bounds.width) return bounds;
		return null;
	}
	for (const bounds of element.getClientRects()) if (bounds.height || bounds.width) return bounds;
	return null;
}

/** Canonical opening geometry only. An open panel holds this result through content updates. */
export function panelTargetBounds(
	root: HTMLElement,
	target: SourceTarget,
	snapshot: RenderSnapshot
): DOMRect | null {
	const context = snapshot.selectionDocument;
	const index = snapshot.source.sourceIndex;
	try {
		validateTarget(index, target);
	} catch {
		return null;
	}
	if (context.index !== index) return null;
	const pages = new Map(
		Array.from(root.querySelectorAll<HTMLElement>('.document-page'))
			.filter((page) => isSelectionPageMounted(page, snapshot))
			.map((page) => [Number(page.dataset.pageNumber), page] as const)
	);
	function boundaryBounds(groups: readonly BreakGroup[]): DOMRect | null {
		const ids = new Set(groups.map((group) => group.id));
		for (const occurrence of context.occurrences) {
			if (occurrence.kind !== 'break' || !ids.has(occurrence.group.id)) continue;
			const controls = pages
				.get(occurrence.page)
				?.querySelector<HTMLElement>(`[data-selection-group="${occurrence.group.id}"]`);
			for (const element of controls?.querySelectorAll<HTMLElement>('[data-structural-boundary]') ??
				[]) {
				const bounds = measureStructuralBoundaryTarget(element)?.bounds;
				if (bounds) return bounds;
			}
		}
		return null;
	}
	if (!isTextTarget(target)) return boundaryBounds(boundaryTargetBreakGroups(context, target));
	const start = pointPosition(index, target.range.start);
	const end = pointPosition(index, target.range.end);
	const candidates: Candidate[] = [];
	for (const occurrence of context.occurrences) {
		if (occurrence.kind !== 'text') continue;
		const token = occurrence.token;
		if (
			!token ||
			!token.value.length ||
			presentationToken(token) ||
			token.generated === 'separator'
		)
			continue;
		if (snapshot.view === 'effective' && (token.revision === 'removed' || !token.value.trim()))
			continue;
		const original = token.source;
		const range =
			original ?? (token.visualSource?.kind === 'text' ? token.visualSource.range : null);
		if (!range) continue;
		const from = pointPosition(index, range.start);
		const to = pointPosition(index, range.end);
		const matches =
			snapshot.view === 'effective' && start === end
				? Boolean(token.visualSource && sameSourceTarget(target, token.visualSource))
				: start === end
					? from <= start && start <= to
					: snapshot.view === 'effective' && !original && from === to
						? start <= from && from <= end
						: from < end && to > start;
		if (!matches) continue;
		candidates.push({
			occurrence,
			priority: snapshot.view === 'redline' && !original ? 1 : 0,
			position: Math.max(start, from),
			offset: original && token.sourceKind === 'text' ? Math.max(0, start - from) : 0
		});
	}
	candidates.sort(
		(a, b) =>
			a.priority - b.priority ||
			a.position - b.position ||
			(snapshot.view === 'redline'
				? (a.occurrence.token?.generatedOffset ?? 0) - (b.occurrence.token?.generatedOffset ?? 0)
				: 0) ||
			a.occurrence.order - b.occurrence.order
	);
	for (const { occurrence, offset } of candidates) {
		const block = pages
			.get(occurrence.page)
			?.querySelector<HTMLElement>(
				`[data-source-fragment-key="${CSS.escape(occurrence.fragment)}"]`
			);
		const element = block?.querySelector<HTMLElement>(
			`[data-selection-token-index="${occurrence.tokenIndex}"]`
		);
		if (!element || element.textContent !== occurrence.value) continue;
		const token = occurrence.token!;
		const bounds = tokenBounds(element, offset, !token.source || token.sourceKind === 'text');
		if (bounds) return bounds;
	}
	return snapshot.view === 'effective'
		? null
		: boundaryBounds(legacyTextNavigationGroups(context, target));
}
