import { crossesBoundary, targetContainers, targetPosition } from '../document/ranges';
import type { ValidationSourceFacts } from '../document/validation-source';
import type { SourceTarget } from './model';

export type ChangeFootprint =
	| {
			kind: 'text';
			start: number;
			end: number;
	  }
	| { kind: 'boundary'; afterBlockKey: string; position: number };

export function changeFootprint(
	index: ValidationSourceFacts,
	change: { readonly target: SourceTarget }
): ChangeFootprint {
	targetContainers(index, change.target);
	if (change.target.kind !== 'text')
		return {
			kind: 'boundary',
			afterBlockKey: change.target.afterBlockKey,
			position: targetPosition(index, change.target)
		};
	return {
		kind: 'text',
		start: targetPosition(index, change.target),
		end: targetPosition(index, change.target, true)
	};
}

function footprintsConflict(x: ChangeFootprint, y: ChangeFootprint): boolean {
	if (x.kind === 'boundary')
		return y.kind === 'boundary'
			? x.afterBlockKey === y.afterBlockKey
			: crossesBoundary(y.start, y.end, x.position);
	if (y.kind === 'boundary') return crossesBoundary(x.start, x.end, y.position);
	const xInsertion = x.start === x.end,
		yInsertion = y.start === y.end;
	return Boolean(
		xInsertion && yInsertion
			? x.start === y.start
			: xInsertion
				? y.start <= x.start && x.start <= y.end
				: yInsertion
					? x.start <= y.start && y.start <= x.end
					: x.start < y.end && y.start < x.end
	);
}

export function changesConflict(
	index: ValidationSourceFacts,
	a: { readonly target: SourceTarget },
	b: { readonly target: SourceTarget }
): boolean {
	return footprintsConflict(changeFootprint(index, a), changeFootprint(index, b));
}

/** Request-local memo: each change's source coordinates are resolved at most once.
 * Keeping it local also accepts in-place draft edits on the next validation call.
 */
export function createChangeConflictChecker(index: ValidationSourceFacts) {
	const footprints = new WeakMap<{ readonly target: SourceTarget }, ChangeFootprint>();
	const footprint = (change: { readonly target: SourceTarget }) => {
		let value = footprints.get(change);
		if (!value) {
			value = changeFootprint(index, change);
			footprints.set(change, value);
		}
		return value;
	};
	return (a: { readonly target: SourceTarget }, b: { readonly target: SourceTarget }) =>
		footprintsConflict(footprint(a), footprint(b));
}

/** Cooperative ordered preparation keeps composition cancellable even during sorting. */
function* sortFootprints<T extends { position: number; order: number }>(
	entries: T[]
): Generator<undefined, T[]> {
	let source = entries,
		destination = new Array<T>(entries.length);
	for (let width = 1; width < entries.length; width *= 2) {
		for (let offset = 0; offset < entries.length; offset += width * 2) {
			const middle = Math.min(offset + width, entries.length),
				end = Math.min(offset + width * 2, entries.length);
			let left = offset,
				right = middle;
			for (let out = offset; out < end; out++) {
				const a = source[left],
					b = source[right];
				const takeLeft =
					left < middle &&
					(right >= end ||
						a.position < b.position ||
						(a.position === b.position && a.order < b.order));
				destination[out] = source[takeLeft ? left++ : right++];
				yield undefined;
			}
		}
		[source, destination] = [destination, source];
	}
	return source;
}

/** Only coordinate candidates reach the canonical predicate. Returns membership, never pairs.
 * Groups exclude changes belonging to the same selected item; composition omits them.
 */
export function* iterateChangeConflicts(
	index: ValidationSourceFacts,
	changes: readonly { readonly target: SourceTarget }[],
	options: {
		groups?: readonly string[];
		firstOnly?: boolean;
		onConflict?: (a: number, b: number) => void;
	} = {}
): Generator<undefined, Set<number>> {
	type Entry = { footprint: ChangeFootprint; position: number; order: number };
	const entries: Entry[] = [];
	for (const [order, change] of changes.entries()) {
		const footprint = changeFootprint(index, change);
		entries.push({
			footprint,
			position: footprint.kind === 'text' ? footprint.start : footprint.position,
			order
		});
		yield undefined;
	}
	const ordered = yield* sortFootprints(entries);
	const active = new Set<Entry>();
	const boundaries = new Map<string, Entry[]>();
	const conflicting = new Set<number>();
	function record(a: Entry, b: Entry) {
		if (options.groups && options.groups[a.order] === options.groups[b.order]) return false;
		if (!footprintsConflict(a.footprint, b.footprint)) return false;
		options.onConflict?.(a.order, b.order);
		conflicting.add(a.order);
		conflicting.add(b.order);
		return true;
	}
	for (const entry of ordered) {
		for (const other of active) {
			// Keep touching intervals until the exact predicate distinguishes insertions.
			if (other.footprint.kind === 'text' && other.footprint.end < entry.position)
				active.delete(other);
			else if (record(other, entry) && options.firstOnly) return conflicting;
			yield undefined;
		}
		if (entry.footprint.kind === 'text') active.add(entry);
		else {
			const key = entry.footprint.afterBlockKey;
			const previous = boundaries.get(key) ?? [];
			for (const other of previous) {
				if (record(other, entry) && options.firstOnly) return conflicting;
				yield undefined;
			}
			previous.push(entry);
			boundaries.set(key, previous);
		}
		yield undefined;
	}
	return conflicting;
}
