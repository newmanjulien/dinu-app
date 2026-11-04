import { PlaybookValidationError } from './validation-error';
import { hasMeaningfulReplacement } from '../contract/replacement-content';
import type { ContractChange, SourcePoint, SourceTarget, Trigger } from './model';
import { isTextTarget } from '../contract/source-model';
import type { SourceIndex, SourceContainer } from '../contract/source-index';
import {
	containsPoint,
	containsRange,
	isEmptyRange,
	localContainer,
	rangesOverlap,
	targetContainers,
	targetIsEmpty,
	targetsOverlap,
	validateTarget
} from '../contract/ranges';

export class GeometryError extends PlaybookValidationError {
	constructor(
		readonly kind: 'trigger-boundary' | 'ambiguous-owner' | 'invalid-slot',
		message: string
	) {
		super(message);
		this.name = 'GeometryError';
	}
}

/** The same intentional-empty-text definition drives discovery and validation. */
export function emptyTriggerPoint(
	index: SourceIndex,
	container: SourceContainer
): SourcePoint | undefined {
	const stored = container.units.filter((unit) => unit.kind !== 'number');
	if (
		container.inTable &&
		stored.length === 1 &&
		stored[0].kind === 'text' &&
		stored[0].length === 0
	)
		return { sourceKey: stored[0].sourceKey, offset: 0 };
}

/** Point discovery belongs to intentional empty source slots, not arbitrary carets. */
export function validateTriggerRange(index: SourceIndex, target: SourceTarget): void {
	validateTarget(index, target);
	if (target.kind === 'boundary' || !isEmptyRange(index, target.range)) return;
	const point = emptyTriggerPoint(index, index.containers.get(localContainer(index, target.range))!);
	if (
		!point ||
		target.range.start.sourceKey !== point.sourceKey ||
		target.range.end.sourceKey !== point.sourceKey
	)
		throw new GeometryError(
			'invalid-slot',
			'Point Triggers require an intentional empty source slot'
		);
}

export function triggersIntersect(index: SourceIndex, a: SourceTarget, b: SourceTarget): boolean {
	if (!isTextTarget(a) || !isTextTarget(b)) return targetsOverlap(index, a, b);
	return (
		rangesOverlap(index, a.range, b.range) ||
		(isEmptyRange(index, a.range) && containsPoint(index, b.range, a.range.start, true)) ||
		(isEmptyRange(index, b.range) && containsPoint(index, a.range, b.range.start, true))
	);
}

/** Throws for partial boundary crossings or ambiguous insertion ownership. */
export function changeTriggerOwner(
	index: SourceIndex,
	triggers: readonly Trigger[],
	change: ContractChange
): Trigger | undefined {
	targetContainers(index, change.range);
	const insertion = targetIsEmpty(index, change.range);
	const owners = triggers.filter((trigger) => {
		if (!isTextTarget(trigger.range) || !isTextTarget(change.range))
			return targetsOverlap(index, trigger.range, change.range);
		if (insertion) return containsPoint(index, trigger.range.range, change.range.range.start, true);
		if (
			isEmptyRange(index, trigger.range.range) &&
			containsPoint(index, change.range.range, trigger.range.range.start, true)
		)
			throw new GeometryError('trigger-boundary', `Change crosses Trigger boundary: ${trigger.id}`);
		if (!rangesOverlap(index, trigger.range.range, change.range.range)) return false;
		if (!containsRange(index, trigger.range.range, change.range.range))
			throw new GeometryError('trigger-boundary', `Change crosses Trigger boundary: ${trigger.id}`);
		return true;
	});
	if (owners.length > 1)
		throw new GeometryError('ambiguous-owner', 'Change has ambiguous Trigger ownership');
	return owners[0];
}

/** Wording only affects geometry through gap insertion; IDs belong to Triggers. */
export function playbookGeometryKey(item: {
	trigger: Trigger;
	concessions: readonly { changes: readonly ContractChange[] }[];
}): string {
	return JSON.stringify([
		item.trigger,
		item.concessions.map((concession) =>
			concession.changes.map((change) => ({
				range: change.range,
				paragraphBreaks: change.replacement.filter((atom) => atom.kind === 'paragraph-break')
					.length,
				hasContent: hasMeaningfulReplacement(change.replacement)
			}))
		)
	]);
}
