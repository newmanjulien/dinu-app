import {
	pointPosition,
	resolvePoint,
	type SourceIndex,
	type StructuralBoundary
} from '$lib/contract/source-index';
import type {
	BoundarySourceTarget,
	SourcePoint,
	SourceRange,
	SourceTarget,
	TextSourceTarget
} from '$lib/contract/source-model';
import {
	crossesBoundary,
	targetPosition,
	unitsInRange,
	validateTarget
} from '$lib/contract/ranges';
import type { PreparedBlock } from '../pagination/prepare';
import {
	fragmentKey,
	type InlineToken,
	type LayoutPlacement,
	type PaginatedPage
} from '../pagination/types';
import { boundaryEndpoints } from './target-coverage';

export interface BreakGroup {
	readonly id: number;
	readonly boundaries: readonly StructuralBoundary[];
	/** Eligible source coverage after source displayed in nonempty output is excluded. */
	readonly collapsed: readonly SourceRange[];
	readonly before?: SourcePoint;
	readonly after?: SourcePoint;
	readonly canonical?: string;
	readonly following?: PreparedBlock;
	readonly trailing?: PreparedBlock;
	readonly label: string;
}
/** Reserved display keys never become persisted source targets. */
export const breakGroupKey = (group: BreakGroup) => group.canonical ?? `gap:selection:${group.id}`;
export const breakGroupKeys = (group: BreakGroup) =>
	group.boundaries.length
		? group.boundaries.map((boundary) => boundary.afterBlockKey)
		: [breakGroupKey(group)];
export interface TextOccurrence {
	readonly kind: 'text';
	readonly order: number;
	readonly page: number;
	readonly placement: LayoutPlacement;
	readonly fragment: string;
	readonly tokenIndex?: number;
	readonly token?: InlineToken;
	readonly row?: number;
	readonly cell?: number;
	readonly value: string;
}
export interface BreakOccurrence {
	readonly kind: 'break';
	readonly order: number;
	readonly page: number;
	readonly placement: LayoutPlacement;
	readonly fragment: string;
	readonly group: BreakGroup;
	readonly edge: 'before' | 'after';
	readonly gap: number;
}
export type DisplayOccurrence = TextOccurrence | BreakOccurrence;
export interface SelectionDocument {
	readonly snapshotId: number;
	readonly index: SourceIndex;
	readonly occurrences: readonly DisplayOccurrence[];
	readonly groups: readonly BreakGroup[];
	readonly pages: ReadonlyMap<number, readonly DisplayOccurrence[]>;
	readonly aliases: ReadonlyMap<string, readonly BreakGroup[]>;
}
export type BreakPolicyContext = SelectionDocument;
export interface DisplayPosition {
	readonly document: SelectionDocument;
	readonly occurrence: number;
	readonly offset: number;
	readonly affinity?: 'upstream' | 'downstream';
}
export interface SelectionCandidate {
	readonly token: object;
	readonly document: SelectionDocument;
	readonly target: SourceTarget;
}
export const comparePositions = (a: DisplayPosition, b: DisplayPosition) =>
	a.occurrence - b.occurrence || a.offset - b.offset;
export const presentationToken = (token: InlineToken) =>
	Boolean(token.lineAnchor || token.generated === 'empty-hit-target');

/** Cooperative, DOM-free metadata construction; never changes layout or token segmentation. */
export function* iterateSelectionDocument(
	snapshotId: number,
	index: SourceIndex,
	prepared: readonly PreparedBlock[],
	pages: readonly PaginatedPage[]
): Generator<undefined, SelectionDocument> {
	const displayed = new Map<string, { from: number; to: number }[]>();
	for (const block of prepared) {
		if (block.flowRole !== 'empty' && block.fragment.type === 'paragraph') {
			for (const [i, token] of block.fragment.tokens.entries()) {
				const source = token.source;
				if (
					!presentationToken(token) &&
					source &&
					source.start.sourceKey === source.end.sourceKey &&
					source.start.offset < source.end.offset
				) {
					const intervals = displayed.get(source.start.sourceKey) ?? [];
					intervals.push({ from: source.start.offset, to: source.end.offset });
					displayed.set(source.start.sourceKey, intervals);
				}
				if (i % 128 === 0) yield undefined;
			}
		}
		yield undefined;
	}
	for (const intervals of displayed.values()) {
		intervals.sort((a, b) => a.from - b.from);
		let count = 0;
		for (let i = 0; i < intervals.length; i++) {
			const interval = intervals[i],
				previous = intervals[count - 1];
			if (previous && interval.from <= previous.to)
				previous.to = Math.max(previous.to, interval.to);
			else intervals[count++] = interval;
			if (i % 128 === 0) yield undefined;
		}
		intervals.length = count;
		yield undefined;
	}
	const groups: BreakGroup[] = [];
	const before = new Map<PreparedBlock, BreakGroup>();
	const after = new Map<PreparedBlock, BreakGroup>();
	let boundaries: StructuralBoundary[] = [],
		collapsed: SourceRange[] = [];
	let hasCollapsedSource = false;
	let previous: PreparedBlock | undefined, last: PreparedBlock | undefined;
	function group(following?: PreparedBlock) {
		// Eligibility refinement must not change which physical breaks exist.
		if ((!following || !previous) && !boundaries.length && !hasCollapsedSource) return;
		const aliases = boundaries
			.filter((b) => index.structuralBoundaries.has(b.afterBlockKey))
			.sort(
				(a, b) =>
					index.blockOrdinals.get(a.afterBlockKey)! - index.blockOrdinals.get(b.afterBlockKey)!
			);
		const first = aliases[0],
			final = aliases.at(-1);
		let label = '';
		if (previous?.fragment.type === 'paragraph')
			for (const token of previous.fragment.tokens) {
				if (!presentationToken(token)) label += token.value.slice(0, 64 - label.length);
				if (label.length >= 64) break;
			}
		const value: BreakGroup = Object.freeze({
			id: groups.length,
			boundaries: Object.freeze(aliases),
			collapsed: Object.freeze(collapsed),
			before: first ? boundaryEndpoints(index, first.afterBlockKey).before : undefined,
			after: final ? boundaryEndpoints(index, final.afterBlockKey).after : undefined,
			canonical: final?.afterBlockKey,
			following,
			trailing: following ? undefined : last,
			label: label ? `after “${label}”` : 'after an empty paragraph'
		});
		groups.push(value);
		if (following) before.set(following, value);
		else if (last) after.set(last, value);
		boundaries = [];
		collapsed = [];
		hasCollapsedSource = false;
	}
	for (const block of prepared) {
		if (block.flowRole !== 'empty') {
			group(block);
			previous = block;
		} else {
			const units = index.containers.get(block.fragment.blockKey)?.units;
			if (units?.length) hasCollapsedSource = true;
			for (const unit of units ?? []) {
				const add = (from: number, to: number) =>
					collapsed.push({
						start: { sourceKey: unit.sourceKey, offset: from },
						end: { sourceKey: unit.sourceKey, offset: to }
					});
				if (!unit.length) add(0, 0);
				else {
					let from = 0;
					for (const [i, interval] of (displayed.get(unit.sourceKey) ?? []).entries()) {
						if (interval.from >= unit.length) break;
						if (from < interval.from) add(from, interval.from);
						from = Math.min(unit.length, Math.max(from, interval.to));
						if (from === unit.length) break;
						if (i % 128 === 0) yield undefined;
					}
					if (from < unit.length) add(from, unit.length);
				}
				yield undefined;
			}
		}
		boundaries.push(...(block.boundariesAfter ?? []));
		last = block;
		yield undefined;
	}
	group();
	displayed.clear();
	const occurrences: DisplayOccurrence[] = [];
	const byPage = new Map<number, readonly DisplayOccurrence[]>();
	for (const page of pages) {
		const local: DisplayOccurrence[] = [];
		const add = (value: Omit<TextOccurrence, 'order'> | Omit<BreakOccurrence, 'order'>) => {
			const occurrence = Object.freeze({
				...value,
				order: occurrences.length
			}) as DisplayOccurrence;
			occurrences.push(occurrence);
			local.push(occurrence);
		};
		for (const placement of page.placements) {
			const { fragment, prepared: block } = placement;
			const base = { page: page.number, placement, fragment: fragmentKey(fragment) };
			const leading = !fragment.interval?.start ? before.get(block) : undefined;
			if (leading)
				add({
					...base,
					kind: 'break',
					group: leading,
					edge: 'before',
					gap: fragment.gapBefore ?? 0
				});
			if (fragment.type === 'paragraph' && block.flowRole !== 'empty') {
				for (const [i, token] of fragment.tokens.entries()) {
					if (!presentationToken(token))
						add({
							...base,
							kind: 'text',
							token,
							tokenIndex: (fragment.interval?.start ?? 0) + i,
							value: token.value
						});
					if (i % 128 === 0) yield undefined;
				}
			} else if (fragment.type === 'table') {
				for (const [r, row] of fragment.rows.entries()) {
					for (const [cell, content] of row.entries()) {
						add({
							...base,
							kind: 'text',
							row: r < fragment.headerRowCount ? r : r + (fragment.interval?.start ?? 0),
							cell,
							value: content.tokens
								.filter((t) => !presentationToken(t))
								.map((t) => t.value)
								.join('')
						});
						yield undefined;
					}
				}
			}
			const trailing = fragment.isFinal ? after.get(block) : undefined;
			if (trailing) add({ ...base, kind: 'break', group: trailing, edge: 'after', gap: 0 });
			yield undefined;
		}
		byPage.set(page.number, Object.freeze(local));
	}
	const aliases = new Map<string, BreakGroup[]>();
	for (const group of groups) {
		for (const boundary of group.boundaries) {
			const values = aliases.get(boundary.afterBlockKey) ?? [];
			values.push(group);
			aliases.set(boundary.afterBlockKey, values);
		}
		yield undefined;
	}
	return Object.freeze({
		snapshotId,
		index,
		occurrences: Object.freeze(occurrences),
		groups: Object.freeze(groups),
		pages: byPage,
		aliases
	});
}

/** Saved boundary aliases locate their current shared break without changing source identity. */
export function boundaryTargetBreakGroups(
	context: BreakPolicyContext,
	target: BoundarySourceTarget
): readonly BreakGroup[] {
	validateTarget(context.index, target);
	return context.aliases.get(target.afterBlockKey) ?? [];
}

/** Navigation fallback for legacy text that is wholly collapsed into related visible breaks.
 * These locations never confer insertion ownership or saved structural paint.
 */
export function legacyTextNavigationGroups(
	context: BreakPolicyContext,
	target: TextSourceTarget
): BreakGroup[] {
	const { index } = context;
	validateTarget(index, target);
	const start = pointPosition(index, target.range.start),
		end = pointPosition(index, target.range.end);
	const pointInCoverage = (point: SourcePoint, range: SourceRange) => {
		const unit = resolvePoint(index, point),
			first = resolvePoint(index, range.start),
			last = resolvePoint(index, range.end);
		const position = unit.position + point.offset;
		return (
			unit.containerKey === first.containerKey &&
			unit.containerKey === last.containerKey &&
			position >= first.position + range.start.offset &&
			position <= last.position + range.end.offset
		);
	};
	const groups = context.groups.filter(
		(group) =>
			group.boundaries.some(({ afterBlockKey }) =>
				crossesBoundary(
					start * 2,
					end * 2,
					targetPosition(index, { kind: 'boundary', afterBlockKey })
				)
			) ||
			group.collapsed.some((range) => {
				const from = pointPosition(index, range.start),
					to = pointPosition(index, range.end);
				return (
					(start < to && end > from) ||
					pointInCoverage(target.range.start, range) ||
					pointInCoverage(target.range.end, range)
				);
			})
	);
	// Numeric emptiness alone cannot associate an old target with an unrelated gap.
	if (!groups.length) return [];
	const coverage = groups
		.flatMap((group) =>
			group.collapsed.map((range) => ({
				from: pointPosition(index, range.start),
				to: pointPosition(index, range.end)
			}))
		)
		.sort((a, b) => a.from - b.from);
	let cursor = 0;
	for (const unit of unitsInRange(index, target.range)) {
		let from = Math.max(start, unit.position);
		const to = Math.min(end, unit.position + unit.length);
		if (from >= to) continue;
		while (cursor < coverage.length && coverage[cursor].to <= from) cursor++;
		for (let i = cursor; i < coverage.length && coverage[i].from <= from; i++) {
			from = Math.max(from, coverage[i].to);
			if (from >= to) break;
		}
		// Check exact selected slices, including whitespace, rather than substantive wording.
		if (from < to) return [];
	}
	return groups;
}

/** Shared visible-gap authoring policy applies only to explicit insertion targets. */
export function shareBoundaryBreak(
	context: BreakPolicyContext,
	a: BoundarySourceTarget,
	b: BoundarySourceTarget
) {
	const ids = new Set(boundaryTargetBreakGroups(context, a).map((group) => group.id));
	return boundaryTargetBreakGroups(context, b).some((group) => ids.has(group.id));
}
