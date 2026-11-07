import type { AnnotationRegistry, AnnotationSegment } from './annotation-registry';
import {
	isTextTarget,
	sameSourceTarget,
	type SourcePoint,
	type SourceTarget
} from '$lib/contract/source-model';
import { pointPosition, type SourceIndex } from '$lib/contract/source-index';
import type { ResolvedRun } from '$lib/contract/model';

export interface AnnotationActivation {
	owner: HTMLElement;
	clientX?: number;
	clientY?: number;
}

export interface AnnotationOccurrence {
	annotationId: string;
	point?: SourcePoint;
	visualSource?: SourceTarget;
	generatedOffset?: number;
	generated?: ResolvedRun['generated'];
	pageNumber: number;
}

type TokenCoordinates = {
	point?: SourcePoint;
	visualSource?: SourceTarget;
	generated?: ResolvedRun['generated'];
	generatedOffset?: number;
};

function tokenCoordinates(token: HTMLElement): TokenCoordinates | undefined {
	let visualSource: SourceTarget | undefined;
	try {
		if (token.dataset.visualSource)
			visualSource = JSON.parse(token.dataset.visualSource) as SourceTarget;
	} catch {
		return;
	}
	visualSource ??= token.dataset.annotationBoundary
		? { kind: 'boundary', afterBlockKey: token.dataset.annotationBoundary }
		: undefined;
	const point =
		(visualSource && isTextTarget(visualSource) ? visualSource.range.start : undefined) ??
		(token.dataset.sourceStartKey
			? {
					sourceKey: token.dataset.sourceStartKey,
					offset: Number(token.dataset.sourceStartOffset)
				}
			: undefined);
	return point || visualSource
		? {
				point,
				visualSource,
				generated: token.dataset.generated as ResolvedRun['generated'],
				generatedOffset: visualSource ? Number(token.dataset.generatedOffset ?? 0) : undefined
			}
		: undefined;
}

function pageNumber(element: HTMLElement) {
	return Number(element.closest<HTMLElement>('[data-page-number]')?.dataset.pageNumber ?? 0);
}

/** Capture text coordinates, never the segment's ordinal or page-local row index. */
export function annotationOccurrence(
	registry: AnnotationRegistry,
	annotationId: string,
	activation: AnnotationActivation
): AnnotationOccurrence | null {
	const { owner, clientX, clientY } = activation;
	if (owner.hasAttribute('data-annotation-projected')) {
		const hit =
			clientX === undefined || clientY === undefined
				? null
				: owner.ownerDocument
						.elementFromPoint(clientX, clientY)
						?.closest<HTMLElement>('[data-contract-token]');
		const first = registry.occurrence(owner)?.segments[0];
		const coordinates = hit
			? tokenCoordinates(hit)
			: first
				? {
						point: first.source?.start,
						visualSource: first.visualSource,
						generated: first.generated,
						generatedOffset: first.generatedStart
					}
				: undefined;
		if (coordinates && hit && clientX !== undefined && clientY !== undefined) {
			const caretDocument = owner.ownerDocument as Document & {
				caretPositionFromPoint?: (
					x: number,
					y: number
				) => { offsetNode: Node; offset: number } | null;
				caretRangeFromPoint?: (x: number, y: number) => Range | null;
			};
			const caret = caretDocument.caretPositionFromPoint?.(clientX, clientY);
			const range = caret ? null : caretDocument.caretRangeFromPoint?.(clientX, clientY);
			const node = caret?.offsetNode ?? range?.startContainer;
			if (node?.nodeType === Node.TEXT_NODE && hit.contains(node)) {
				const offset = Math.min(
					caret?.offset ?? range?.startOffset ?? 0,
					Math.max(0, (node.textContent?.length ?? 0) - 1)
				);
				if (coordinates.visualSource)
					coordinates.generatedOffset = (coordinates.generatedOffset ?? 0) + offset;
				else if (coordinates.point && hit.dataset.sourceKind === 'text')
					coordinates.point.offset += offset;
			}
		}
		return coordinates ? { annotationId, ...coordinates, pageNumber: pageNumber(owner) } : null;
	}
	const distance = (token: HTMLElement) => {
		if (clientX === undefined || clientY === undefined) return 0;
		const range = owner.ownerDocument.createRange();
		range.selectNodeContents(token);
		let nearest = Infinity;
		for (const bounds of range.getClientRects())
			nearest = Math.min(
				nearest,
				Math.hypot(
					Math.max(bounds.left - clientX, 0, clientX - bounds.right),
					Math.max(bounds.top - clientY, 0, clientY - bounds.bottom)
				)
			);
		return nearest;
	};
	let token: HTMLElement | undefined;
	let nearest = Infinity;
	for (const candidate of owner.querySelectorAll<HTMLElement>(
		'[data-source-start-key], [data-visual-source], [data-annotation-boundary]'
	)) {
		const measured = distance(candidate);
		if (!token || measured < nearest) {
			token = candidate;
			nearest = measured;
		}
	}
	if (!token) return null;
	const coordinates = tokenCoordinates(token);
	if (!coordinates) return null;
	// Preserve the character within a long run as well as its token after repagination.
	const caretDocument = owner.ownerDocument as Document & {
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};
	let offset = 0;
	if (clientX !== undefined && clientY !== undefined) {
		const position = caretDocument.caretPositionFromPoint?.(clientX, clientY);
		const range = position ? null : caretDocument.caretRangeFromPoint?.(clientX, clientY);
		const node = position?.offsetNode ?? range?.startContainer;
		if (node?.nodeType === Node.TEXT_NODE && token.contains(node))
			offset = Math.min(
				position?.offset ?? range?.startOffset ?? 0,
				Math.max(0, (token.textContent?.length ?? 0) - 1)
			);
	}
	if (coordinates.visualSource)
		coordinates.generatedOffset = (coordinates.generatedOffset ?? 0) + offset;
	else if (coordinates.point && token.dataset.sourceKind === 'text')
		coordinates.point.offset += offset;
	return { annotationId, ...coordinates, pageNumber: pageNumber(owner) };
}

export interface AnnotationAnchor {
	owner: HTMLElement;
}

function ranksBefore(rank: number[], previous: number[]): boolean {
	for (let i = 0; i < rank.length; i++) if (rank[i] !== previous[i]) return rank[i] < previous[i];
	return false;
}

/** Resolve a stable annotation owner for focus restoration across repagination. */
export function resolveAnnotationAnchor(
	registry: AnnotationRegistry,
	index: SourceIndex,
	annotationId: string | null,
	preference: AnnotationOccurrence | null,
	fallbackPoint?: SourcePoint
): AnnotationAnchor | undefined {
	if (!annotationId) return;
	const point = preference?.point ?? fallbackPoint;
	// A captured point may outlive its source unit or the unit's previous length.
	const unit = point ? index.byKey.get(point.sourceKey) : undefined;
	const position = unit && point ? unit.position + Math.min(point.offset, unit.length) : undefined;
	let best: (AnnotationAnchor & { rank: number[] }) | undefined;
	for (const owner of registry.forAnnotation(annotationId)) {
		const projected = registry.occurrence(owner);
		const segments: readonly AnnotationSegment[] =
			projected?.segments ??
			Array.from(
				owner.querySelectorAll<HTMLElement>(
					'[data-source-start-key], [data-visual-source], [data-annotation-boundary]'
				)
			).flatMap((token): AnnotationSegment[] => {
				const coordinates = tokenCoordinates(token);
				if (!coordinates) return [];
				return [
					{
						source: coordinates.visualSource
							? isTextTarget(coordinates.visualSource)
								? coordinates.visualSource.range
								: undefined
							: coordinates.point && token.dataset.sourceEndKey
								? {
										start: coordinates.point,
										end: {
											sourceKey: token.dataset.sourceEndKey,
											offset: Number(token.dataset.sourceEndOffset)
										}
									}
								: undefined,
						visualSource: coordinates.visualSource,
						generated: coordinates.generated,
						generatedStart: coordinates.generatedOffset,
						generatedEnd: (coordinates.generatedOffset ?? 0) + (token.textContent?.length ?? 0)
					}
				];
			});
		for (const segment of segments) {
			const source = segment.source,
				coordinates = segment;
			const start = source ? pointPosition(index, source.start) : undefined,
				end = source ? pointPosition(index, source.end) : undefined;
			const sourceDistance =
				position === undefined || start === undefined || end === undefined
					? 0
					: Math.max(start - position, 0, position - end);
			const sameReplacement =
				preference?.visualSource &&
				coordinates.visualSource &&
				preference.generated === coordinates.generated &&
				sameSourceTarget(preference.visualSource, coordinates.visualSource);
			const offset = segment.generatedStart ?? 0,
				generatedEnd = segment.generatedEnd ?? offset;
			const generatedDistance = sameReplacement
				? Math.max(
						offset - (preference.generatedOffset ?? 0),
						0,
						(preference.generatedOffset ?? 0) - generatedEnd
					)
				: 0;
			const containsSource =
				position !== undefined &&
				start !== undefined &&
				end !== undefined &&
				position >= start &&
				(position < end || start === end);
			const containsGenerated =
				(preference?.generatedOffset ?? 0) >= offset &&
				(preference?.generatedOffset ?? 0) < generatedEnd;
			const exact = preference?.visualSource
				? Boolean(sameReplacement) &&
					(isTextTarget(preference.visualSource) ? containsGenerated : true)
				: !coordinates.visualSource && containsSource;
			const matchingProvenance = preference?.visualSource
				? Boolean(sameReplacement)
				: !coordinates.visualSource;
			const rank = [
				matchingProvenance ? 0 : 1,
				exact ? 0 : 1,
				sourceDistance,
				sameReplacement ? generatedDistance : 0,
				preference ? Math.abs(pageNumber(owner) - preference.pageNumber) : 0
			];
			if (!best || ranksBefore(rank, best.rank)) {
				best = { owner, rank };
			}
		}
	}
	return best;
}
