import type { ContractChange } from './model';
import { pointPosition, type SourceIndex } from '../contract/source-index';
import { isTextTarget } from '../contract/source-model';
import { targetContainers } from '../contract/ranges';

export type ChangeFootprint =
	| {
			kind: 'text';
			start: number;
			end: number;
	  }
	| { kind: 'boundary'; afterBlockKey: string };

export function changeFootprint(index: SourceIndex, change: ContractChange): ChangeFootprint {
	targetContainers(index, change.range);
	if (!isTextTarget(change.range))
		return { kind: 'boundary', afterBlockKey: change.range.afterBlockKey };
	return {
		kind: 'text',
		start: pointPosition(index, change.range.range.start),
		end: pointPosition(index, change.range.range.end)
	};
}

function footprintsConflict(x: ChangeFootprint, y: ChangeFootprint): boolean {
	if (x.kind === 'boundary' || y.kind === 'boundary')
		return x.kind === 'boundary' && y.kind === 'boundary' && x.afterBlockKey === y.afterBlockKey;
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

export function changesConflict(index: SourceIndex, a: ContractChange, b: ContractChange): boolean {
	return footprintsConflict(changeFootprint(index, a), changeFootprint(index, b));
}

/** Request-local memo: each change's source coordinates are resolved at most once.
 * Keeping it local also accepts in-place draft edits on the next validation call.
 */
export function createChangeConflictChecker(index: SourceIndex) {
	const footprints = new WeakMap<ContractChange, ChangeFootprint>();
	const footprint = (change: ContractChange) => {
		let value = footprints.get(change);
		if (!value) {
			value = changeFootprint(index, change);
			footprints.set(change, value);
		}
		return value;
	};
	return (a: ContractChange, b: ContractChange) => footprintsConflict(footprint(a), footprint(b));
}
