import {
	containsPoint,
	containsRange,
	crossesBoundary,
	isEmptyRange,
	rangesOverlap,
	targetContainers,
	targetIsEmpty,
	targetPosition,
	targetsOverlap,
	validateTarget
} from '../contract/ranges';
import { hasMeaningfulReplacement } from '../contract/replacement-content';
import type { ValidationSourceFacts } from '../contract/validation-source';
import { isTextTarget } from '../contract/source-model';
import type { ContractChange, SourceTarget, Trigger } from './model';
import { PlaybookValidationError } from './validation-error';

export class GeometryError extends PlaybookValidationError {
	constructor(
		readonly kind: 'trigger-boundary' | 'ambiguous-owner' | 'invalid-slot',
		message: string
	) {
		super(message);
		this.name = 'GeometryError';
	}
}

/** Empty text cannot own a Trigger; insertions use explicit structural boundaries. */
export function validateTriggerRange(index: ValidationSourceFacts, target: SourceTarget): void {
	validateTarget(index, target);
	if (target.kind === 'text' && isEmptyRange(index, target.range))
		throw new GeometryError('invalid-slot', 'Triggers require text or a structural boundary');
}

export function triggersIntersect(
	index: ValidationSourceFacts,
	a: SourceTarget,
	b: SourceTarget
): boolean {
	if (!isTextTarget(a) || !isTextTarget(b)) return targetsOverlap(index, a, b);
	return (
		rangesOverlap(index, a.range, b.range) ||
		(isEmptyRange(index, a.range) && containsPoint(index, b.range, a.range.start, true)) ||
		(isEmptyRange(index, b.range) && containsPoint(index, a.range, b.range.start, true))
	);
}

/** A text change occupies real boundaries strictly between its endpoints. */
export function changeCrossesBoundaryTrigger(
	index: ValidationSourceFacts,
	changeTarget: SourceTarget,
	triggerTarget: SourceTarget
): boolean {
	return (
		changeTarget.kind === 'text' &&
		triggerTarget.kind === 'boundary' &&
		crossesBoundary(
			targetPosition(index, changeTarget),
			targetPosition(index, changeTarget, true),
			targetPosition(index, triggerTarget)
		)
	);
}

/** Throws for partial boundary crossings or ambiguous insertion ownership. */
export function changeTriggerOwner(
	index: ValidationSourceFacts,
	triggers: readonly Trigger[],
	change: ContractChange
): Trigger | undefined {
	targetContainers(index, change.target);
	const insertion = targetIsEmpty(index, change.target);
	const owners = triggers.filter((trigger) => {
		if (changeCrossesBoundaryTrigger(index, change.target, trigger.target))
			throw new GeometryError('trigger-boundary', `Change crosses Trigger boundary: ${trigger.id}`);
		if (!isTextTarget(trigger.target) || !isTextTarget(change.target))
			return targetsOverlap(index, trigger.target, change.target);
		if (insertion)
			return containsPoint(index, trigger.target.range, change.target.range.start, true);
		if (
			isEmptyRange(index, trigger.target.range) &&
			containsPoint(index, change.target.range, trigger.target.range.start, true)
		)
			throw new GeometryError('trigger-boundary', `Change crosses Trigger boundary: ${trigger.id}`);
		if (!rangesOverlap(index, trigger.target.range, change.target.range)) return false;
		if (!containsRange(index, trigger.target.range, change.target.range))
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
				range: change.target,
				paragraphBreaks: change.replacement.filter((atom) => atom.kind === 'paragraph-break')
					.length,
				hasContent: hasMeaningfulReplacement(change.replacement)
			}))
		)
	]);
}
