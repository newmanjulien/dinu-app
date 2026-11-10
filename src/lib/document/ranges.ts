import type { ValidationSourceFacts, ValidationContainer } from './validation-source';
import { PlaybookValidationError } from '../playbook/validation-error';
import {
	isTextTarget,
	type SourcePoint,
	type SourceRange,
	type SourceTarget
} from './source-model';
import { pointPosition, resolvePoint, type SourceIndex, type SourceUnit } from './source-index';

export const comparePoints = (
	index: ValidationSourceFacts,
	a: SourcePoint,
	b: SourcePoint
): number => Math.sign(pointPosition(index, a) - pointPosition(index, b));

/** Text and boundaries sort together without inventing fractional source coordinates. */
function targetOrder(index: ValidationSourceFacts, target: SourceTarget, end = false): number {
	if (isTextTarget(target))
		return pointPosition(index, end ? target.range.end : target.range.start) * 2;
	const container = index.containers.get(target.afterBlockKey);
	if (!container)
		throw new PlaybookValidationError(`Invalid structural boundary: ${target.afterBlockKey}`);
	const unit = container.units.at(-1);
	if (!unit) throw new PlaybookValidationError(`Empty boundary owner: ${target.afterBlockKey}`);
	// A boundary follows text ending at the same logical position and precedes the next block.
	return (unit.position + unit.length) * 2 + 1;
}

export function structuralBoundary(index: ValidationSourceFacts, target: SourceTarget) {
	return target.kind === 'boundary'
		? index.structuralBoundaries.get(target.afterBlockKey)
		: undefined;
}

export function validateTarget(index: ValidationSourceFacts, target: SourceTarget): void {
	if (isTextTarget(target)) {
		validateRange(index, target.range);
		return;
	}
	if (!structuralBoundary(index, target))
		throw new PlaybookValidationError(`Invalid structural boundary: ${target.afterBlockKey}`);
}

export function compareTargets(
	index: ValidationSourceFacts,
	a: SourceTarget,
	b: SourceTarget
): number {
	validateTarget(index, a);
	validateTarget(index, b);
	return Math.sign(targetOrder(index, a) - targetOrder(index, b));
}
export function validateRange(index: ValidationSourceFacts, range: SourceRange): void {
	if (comparePoints(index, range.start, range.end) > 0)
		throw new PlaybookValidationError('Source range is reversed');
	const start = index.containers.get(resolvePoint(index, range.start).containerKey)!;
	const end = index.containers.get(resolvePoint(index, range.end).containerKey)!;
	if (start.region !== end.region)
		throw new PlaybookValidationError('Selections cannot cross tables');
}
export function isEmptyRange(index: ValidationSourceFacts, range: SourceRange): boolean {
	validateRange(index, range);
	return comparePoints(index, range.start, range.end) === 0;
}
/** Half-open geometry. Empty ranges do not overlap; edit collisions are a separate policy. */
export function rangesOverlap(
	index: ValidationSourceFacts,
	a: SourceRange,
	b: SourceRange
): boolean {
	const aIsEmpty = isEmptyRange(index, a);
	const bIsEmpty = isEmptyRange(index, b);
	return (
		!aIsEmpty &&
		!bIsEmpty &&
		comparePoints(index, a.start, b.end) < 0 &&
		comparePoints(index, b.start, a.end) < 0
	);
}
export function containsPoint(
	index: ValidationSourceFacts,
	range: SourceRange,
	point: SourcePoint,
	includeEnd = false
): boolean {
	validateRange(index, range);
	return (
		comparePoints(index, range.start, point) <= 0 &&
		(includeEnd
			? comparePoints(index, point, range.end) <= 0
			: comparePoints(index, point, range.end) < 0)
	);
}
export function containsRange(
	index: ValidationSourceFacts,
	outer: SourceRange,
	inner: SourceRange
): boolean {
	validateRange(index, outer);
	validateRange(index, inner);
	return (
		comparePoints(index, outer.start, inner.start) <= 0 &&
		comparePoints(index, inner.end, outer.end) <= 0
	);
}
export function localContainer(index: ValidationSourceFacts, range: SourceRange): string {
	validateRange(index, range);
	const start = resolvePoint(index, range.start),
		end = resolvePoint(index, range.end);
	if (start.containerKey !== end.containerKey)
		throw new PlaybookValidationError('Edit must target one source container');
	return start.containerKey;
}

/** One cell, one text block, or consecutive flow paragraphs. */
export function rangeContainers(
	index: SourceIndex,
	range: SourceRange
): import('./source-index').SourceContainer[];
export function rangeContainers(
	index: ValidationSourceFacts,
	range: SourceRange
): ValidationContainer[];
export function rangeContainers(
	index: ValidationSourceFacts,
	range: SourceRange
): ValidationContainer[] {
	validateRange(index, range);
	const start = resolvePoint(index, range.start),
		end = resolvePoint(index, range.end);
	if (start.containerKey === end.containerKey) return [index.containers.get(start.containerKey)!];
	const first = index.blockOrdinals.get(start.blockKey)!;
	const last = index.blockOrdinals.get(end.blockKey)!;
	const selected = index.orderedBlocks.slice(first, last + 1);
	if (selected.some((block) => block.kind !== 'paragraph'))
		throw new PlaybookValidationError('Select consecutive paragraphs');
	return selected.map((block) => index.containers.get(block.blockKey)!);
}

/** A boundary borrows its real preceding container for ownership checks only. */
export function targetContainers(
	index: SourceIndex,
	target: SourceTarget
): import('./source-index').SourceContainer[];
export function targetContainers(
	index: ValidationSourceFacts,
	target: SourceTarget
): ValidationContainer[];
export function targetContainers(
	index: ValidationSourceFacts,
	target: SourceTarget
): ValidationContainer[] {
	validateTarget(index, target);
	if (isTextTarget(target)) return rangeContainers(index, target.range);
	return [index.containers.get(target.afterBlockKey)!];
}

export function targetIsEmpty(index: ValidationSourceFacts, target: SourceTarget): boolean {
	validateTarget(index, target);
	return target.kind === 'boundary' || isEmptyRange(index, target.range);
}

/** Text geometry overlaps only text geometry. Boundaries collide only with themselves. */
export function targetsOverlap(
	index: ValidationSourceFacts,
	a: SourceTarget,
	b: SourceTarget
): boolean {
	validateTarget(index, a);
	validateTarget(index, b);
	if (a.kind === 'boundary' || b.kind === 'boundary')
		return a.kind === 'boundary' && b.kind === 'boundary' && a.afterBlockKey === b.afterBlockKey;
	return rangesOverlap(index, a.range, b.range);
}

export function targetPosition(
	index: ValidationSourceFacts,
	target: SourceTarget,
	end = false
): number {
	validateTarget(index, target);
	return targetOrder(index, target, end);
}

/** Strict crossing in targetPosition coordinates; touching a boundary has no structural effect. */
export function crossesBoundary(start: number, end: number, boundary: number): boolean {
	return start < boundary && boundary < end;
}

export function unitsInRange(index: SourceIndex, range: SourceRange): readonly SourceUnit[] {
	validateRange(index, range);
	const start = pointPosition(index, range.start),
		end = pointPosition(index, range.end);
	if (start === end) return [resolvePoint(index, range.start)];
	// Source units and their ends are ordered, including persisted empty anchors.
	const units = index.units;
	let low = 0,
		high = units.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (units[mid].position + units[mid].length <= start) low = mid + 1;
		else high = mid;
	}
	let last = low;
	while (last < units.length && units[last].position < end) last++;
	return units.slice(low, last);
}
