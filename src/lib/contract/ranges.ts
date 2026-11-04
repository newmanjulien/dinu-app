import { PlaybookValidationError } from '../playbook/validation-error';
import {
	isTextTarget,
	type SourcePoint,
	type SourceRange,
	type SourceTarget
} from './source-model';
import { pointPosition, resolvePoint, type SourceIndex, type SourceUnit } from './source-index';

export const comparePoints = (index: SourceIndex, a: SourcePoint, b: SourcePoint): number =>
	Math.sign(pointPosition(index, a) - pointPosition(index, b));

/** Text and boundaries sort together without inventing fractional source coordinates. */
function targetOrder(index: SourceIndex, target: SourceTarget, end = false): number {
	if (isTextTarget(target)) return pointPosition(index, end ? target.range.end : target.range.start) * 2;
	const container = index.containers.get(target.afterBlockKey);
	if (!container) throw new PlaybookValidationError(`Invalid structural boundary: ${target.afterBlockKey}`);
	const unit = container.units.at(-1);
	if (!unit) throw new PlaybookValidationError(`Empty boundary owner: ${target.afterBlockKey}`);
	// A boundary follows text ending at the same logical position and precedes the next block.
	return (unit.position + unit.length) * 2 + 1;
}

export function structuralBoundary(index: SourceIndex, target: SourceTarget) {
	return target.kind === 'boundary'
		? index.structuralBoundaries.get(target.afterBlockKey)
		: undefined;
}

export function validateTarget(index: SourceIndex, target: SourceTarget): void {
	if (isTextTarget(target)) {
		validateRange(index, target.range);
		return;
	}
	if (!structuralBoundary(index, target))
		throw new PlaybookValidationError(`Invalid structural boundary: ${target.afterBlockKey}`);
}

export function compareTargets(index: SourceIndex, a: SourceTarget, b: SourceTarget): number {
	validateTarget(index, a);
	validateTarget(index, b);
	return Math.sign(targetOrder(index, a) - targetOrder(index, b));
}
export function validateRange(index: SourceIndex, range: SourceRange): void {
	if (comparePoints(index, range.start, range.end) > 0)
		throw new PlaybookValidationError('Source range is reversed');
}
export function isEmptyRange(index: SourceIndex, range: SourceRange): boolean {
	validateRange(index, range);
	return comparePoints(index, range.start, range.end) === 0;
}
/** Half-open geometry. Empty ranges do not overlap; edit collisions are a separate policy. */
export function rangesOverlap(index: SourceIndex, a: SourceRange, b: SourceRange): boolean {
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
	index: SourceIndex,
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
export function containsRange(index: SourceIndex, outer: SourceRange, inner: SourceRange): boolean {
	validateRange(index, outer);
	validateRange(index, inner);
	return (
		comparePoints(index, outer.start, inner.start) <= 0 &&
		comparePoints(index, inner.end, outer.end) <= 0
	);
}
export function localContainer(index: SourceIndex, range: SourceRange): string {
	validateRange(index, range);
	const start = resolvePoint(index, range.start),
		end = resolvePoint(index, range.end);
	if (start.containerKey !== end.containerKey)
		throw new PlaybookValidationError('Edit must target one source container');
	return start.containerKey;
}

/** One continuous affected location, including a local cell or consecutive flow paragraphs. */
export function rangeContainers(index: SourceIndex, range: SourceRange) {
	validateRange(index, range);
	const start = resolvePoint(index, range.start),
		end = resolvePoint(index, range.end);
	if (start.containerKey === end.containerKey) return [index.containers.get(start.containerKey)!];
	const first = index.blockOrdinals.get(start.blockKey)!;
	const last = index.blockOrdinals.get(end.blockKey)!;
	const selected = index.orderedBlocks.slice(first, last + 1);
	if (start.inTable || end.inTable || selected.some((block) => block.kind !== 'paragraph'))
		throw new PlaybookValidationError(
			'Select consecutive paragraphs or text within one table cell'
		);
	return selected.map((block) => index.containers.get(block.blockKey)!);
}

/** A boundary borrows its real preceding container for ownership checks only. */
export function targetContainers(index: SourceIndex, target: SourceTarget) {
	validateTarget(index, target);
	if (isTextTarget(target)) return rangeContainers(index, target.range);
	return [index.containers.get(target.afterBlockKey)!];
}

export function targetIsEmpty(index: SourceIndex, target: SourceTarget): boolean {
	validateTarget(index, target);
	return target.kind === 'boundary' || isEmptyRange(index, target.range);
}

/** Text geometry overlaps only text geometry. Boundaries collide only with themselves. */
export function targetsOverlap(index: SourceIndex, a: SourceTarget, b: SourceTarget): boolean {
	validateTarget(index, a);
	validateTarget(index, b);
	if (a.kind === 'boundary' || b.kind === 'boundary')
		return a.kind === 'boundary' && b.kind === 'boundary' && a.afterBlockKey === b.afterBlockKey;
	return rangesOverlap(index, a.range, b.range);
}

export function targetPosition(index: SourceIndex, target: SourceTarget, end = false): number {
	validateTarget(index, target);
	return targetOrder(index, target, end);
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
export function rangeTouchesTable(index: SourceIndex, range: SourceRange): boolean {
	validateRange(index, range);
	const start = pointPosition(index, range.start),
		end = pointPosition(index, range.end);
	return (
		resolvePoint(index, range.start).inTable ||
		resolvePoint(index, range.end).inTable ||
		index.units.some((u) => u.inTable && u.position < end && u.position + u.length >= start)
	);
}
