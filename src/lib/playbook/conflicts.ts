import { crossesBoundary, targetContainers, targetPosition } from '../contract/ranges';
import type { ValidationSourceFacts } from '../contract/validation-source';
import { isTextTarget } from '../contract/source-model';
import type { ContractChange } from './model';

export type ChangeFootprint =
	| {
			kind: 'text';
			start: number;
			end: number;
	  }
	| { kind: 'boundary'; afterBlockKey: string; position: number };

export function changeFootprint(
	index: ValidationSourceFacts,
	change: ContractChange
): ChangeFootprint {
	targetContainers(index, change.target);
	if (!isTextTarget(change.target))
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
	a: ContractChange,
	b: ContractChange
): boolean {
	return footprintsConflict(changeFootprint(index, a), changeFootprint(index, b));
}

/** Request-local memo: each change's source coordinates are resolved at most once.
 * Keeping it local also accepts in-place draft edits on the next validation call.
 */
export function createChangeConflictChecker(index: ValidationSourceFacts) {
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
