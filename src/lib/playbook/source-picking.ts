import type { DeepReadonly } from '../immutable';
import { validateTarget } from '../document/ranges';
import type { SourceIndex } from '../document/source-index';
import { changesConflict } from './conflicts';
import { changeStructure } from './structure';
import { templateCopy } from './template-copy';
import { GeometryError, triggersIntersect } from './geometry';
import type { PlaybookGeometryIndex } from './geometry-index';
import type { Concession, ContractChange, SourceTarget, TemplateAudience, Trigger } from './model';

import {
	shareBoundaryBreak,
	type BreakPolicyContext
} from '$lib/document/selection/selection-model';

export type SelectionIssue =
	| { kind: 'item-overlap'; diagnostic?: unknown }
	| { kind: 'concession-boundary-conflict'; diagnostic?: unknown }
	| { kind: 'primary-change-overlap' }
	| { kind: 'cross-container' }
	| { kind: 'text-required' }
	| { kind: 'unmappable'; diagnostic?: unknown }
	| { kind: 'unavailable' }
	| { kind: 'unexpected'; diagnostic: unknown };
export type SelectionEligibility = { allowed: true } | { allowed: false; issue: SelectionIssue };
/** Action restrictions stay distinct from source/geometry failures. */
export type SelectionAvailability = SelectionEligibility | { allowed: false; reason: string };

export function selectionIssueMessage(issue: SelectionIssue, audience: TemplateAudience): string {
	switch (issue.kind) {
		case 'item-overlap':
			return templateCopy(audience).selectionOverlap;
		case 'concession-boundary-conflict':
			return "Concessions can't be added when the highlighted text spans an existing insertion point.";
		case 'primary-change-overlap':
			return "You can't highlight text this concession already changes.";
		case 'cross-container':
			return 'Select a continuous passage of adjacent paragraphs.';
		case 'text-required':
			return 'Select the text you want to explain to buyers.';
		case 'unmappable':
			return 'This selection can’t be attached to the current template. Select template text only.';
		case 'unavailable':
			return 'Wait for the current template';
		case 'unexpected':
			return "Couldn't validate this selection. Please try again.";
	}
}

/** Translate neutral geometry invariants at the authoring boundary. */
export function geometrySelectionIssue(diagnostic: GeometryError): SelectionIssue {
	switch (diagnostic.kind) {
		case 'trigger-boundary':
		case 'ambiguous-owner':
			return { kind: 'item-overlap', diagnostic };
		case 'invalid-slot':
			return { kind: 'unmappable', diagnostic };
	}
}

function failureIssue(diagnostic: unknown): SelectionIssue {
	return diagnostic instanceof GeometryError
		? geometrySelectionIssue(diagnostic)
		: { kind: 'unexpected', diagnostic };
}

function evaluate(check: () => SelectionEligibility): SelectionEligibility {
	try {
		return check();
	} catch (diagnostic) {
		return { allowed: false, issue: failureIssue(diagnostic) };
	}
}

function sourceIssue(index: SourceIndex, range: SourceTarget): SelectionIssue | undefined {
	try {
		validateTarget(index, range);
	} catch {
		return { kind: 'unmappable' };
	}
}

function hasBreakItems(
	context: BreakPolicyContext,
	target: SourceTarget,
	geometry: PlaybookGeometryIndex,
	exclude?: string
) {
	if (target.kind !== 'boundary') return false;
	for (const [itemId, entry] of geometry.items) {
		if (itemId === exclude) continue;
		if (
			entry.triggers.some(
				({ trigger }) =>
					trigger.target.kind === 'boundary' && shareBoundaryBreak(context, target, trigger.target)
			)
		)
			return true;
		if (
			entry.changes.some(
				({ change }) =>
					change.target.kind === 'boundary' && shareBoundaryBreak(context, target, change.target)
			)
		)
			return true;
	}
	return false;
}

export function evaluateSecondarySelection(
	index: SourceIndex,
	range: SourceTarget,
	trigger: DeepReadonly<Trigger>,
	persistedId: string | undefined,
	geometry: PlaybookGeometryIndex,
	context: BreakPolicyContext,
	concession: DeepReadonly<Concession>
): SelectionEligibility {
	return evaluate(() => {
		if (context.index !== index) return { allowed: false, issue: { kind: 'unavailable' } };
		const issue = sourceIssue(index, range);
		if (issue) return { allowed: false, issue };
		if (!concession.changes[0])
			throw new Error('Secondary selection requires a composing concession');
		const proposed: ContractChange = { target: range, replacement: [] };
		if (
			changesConflict(index, concession.changes[0], proposed) ||
			(range.kind === 'boundary' &&
				concession.changes[0].target.kind === 'boundary' &&
				shareBoundaryBreak(context, range, concession.changes[0].target))
		)
			return { allowed: false, issue: { kind: 'primary-change-overlap' } };
		if (
			geometry.triggersIntersecting(range, persistedId).length ||
			hasBreakItems(context, range, geometry, persistedId)
		)
			return { allowed: false, issue: { kind: 'item-overlap' } };
		if (
			triggersIntersect(index, trigger.target, range) ||
			(trigger.target.kind === 'boundary' &&
				range.kind === 'boundary' &&
				shareBoundaryBreak(context, trigger.target, range))
		)
			return { allowed: false, issue: { kind: 'item-overlap' } };
		geometry.validateTriggersReplacing(persistedId, [trigger]);
		geometry.validateChanges([concession.changes[0], proposed].map(changeStructure), persistedId, [
			trigger
		]);
		return { allowed: true };
	});
}

/** Existing and new instructions use the same concession-addition geometry. */
export function evaluateConcessionAddition(
	index: SourceIndex,
	trigger: DeepReadonly<Trigger>,
	persistedId: string | undefined,
	geometry: PlaybookGeometryIndex,
	context: BreakPolicyContext
): SelectionEligibility {
	return evaluate(() => {
		const range = trigger.target;
		if (context.index !== index) return { allowed: false, issue: { kind: 'unavailable' } };
		const issue = sourceIssue(index, range);
		if (issue) return { allowed: false, issue };
		if (hasBreakItems(context, range, geometry, persistedId))
			return { allowed: false, issue: { kind: 'item-overlap' } };
		geometry.validateTriggersReplacing(persistedId, [trigger]);
		try {
			geometry.validateChanges(
				[{ target: range, paragraphBreaks: 0, meaningful: false }],
				persistedId,
				[trigger]
			);
		} catch (diagnostic) {
			if (diagnostic instanceof GeometryError && diagnostic.kind === 'trigger-boundary')
				return { allowed: false, issue: { kind: 'concession-boundary-conflict', diagnostic } };
			throw diagnostic;
		}
		return { allowed: true };
	});
}

/** Validate initial trigger eligibility for the active audience. */
export function evaluateInitialSelection(
	index: SourceIndex,
	range: SourceTarget,
	geometry: PlaybookGeometryIndex,
	context: BreakPolicyContext,
	audience: TemplateAudience
): SelectionEligibility {
	return evaluate(() => {
		if (context.index !== index) return { allowed: false, issue: { kind: 'unavailable' } };
		if (audience === 'buyer' && range.kind !== 'text')
			return { allowed: false, issue: { kind: 'text-required' } };
		const issue = sourceIssue(index, range);
		if (issue) return { allowed: false, issue };
		if (geometry.triggersIntersecting(range).length || hasBreakItems(context, range, geometry))
			return { allowed: false, issue: { kind: 'item-overlap' } };
		let id = 'candidate-trigger';
		while (geometry.triggerIds.has(id)) id += '-';
		geometry.validateTriggersReplacing(undefined, [{ id, target: range }]);
		return { allowed: true };
	});
}
