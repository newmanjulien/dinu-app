import { structuralBoundary, validateTarget } from '../contract/ranges';
import type { SourceIndex } from '../contract/source-index';
import { changesConflict } from './conflicts';
import type { PlaybookDraft } from './draft';
import { GeometryError, triggersIntersect } from './geometry';
import type { PlaybookGeometryIndex } from './geometry-index';
import type { Concession, ContractChange, SourceTarget } from './model';

import {
	shareBoundaryBreak,
	type BreakPolicyContext
} from '$lib/document/selection/selection-model';

export type AuthoringMode = 'explain' | 'concession';
export type SelectionIssue =
	| { kind: 'instructions-overlap'; diagnostic?: unknown }
	| { kind: 'primary-change-overlap' }
	| { kind: 'cross-container' }
	| { kind: 'unmappable'; diagnostic?: unknown }
	| { kind: 'unavailable' }
	| { kind: 'unexpected'; diagnostic: unknown };
export type ActionEligibility = { enabled: true } | { enabled: false; reason: string };
export type SelectionActions = Readonly<Record<AuthoringMode, ActionEligibility>>;
export type SelectionEligibility =
	{ allowed: true; actions: SelectionActions } | { allowed: false; issue: SelectionIssue };
/** Action restrictions stay distinct from source/geometry failures. */
export type SelectionAvailability = SelectionEligibility | { allowed: false; reason: string };

export function selectionIssueMessage(issue: SelectionIssue): string {
	switch (issue.kind) {
		case 'instructions-overlap':
			return "You can't highlight text that already has instructions attached";
		case 'primary-change-overlap':
			return "You can't highlight text this concession already changes.";
		case 'cross-container':
			return 'Select a continuous passage of adjacent paragraphs.';
		case 'unmappable':
			return 'This selection can’t be attached to the current contract. Select contract text only.';
		case 'unavailable':
			return 'Wait for the current contract';
		case 'unexpected':
			return "Couldn't validate this selection. Please try again.";
	}
}

/** Translate neutral geometry invariants at the authoring boundary. */
export function geometrySelectionIssue(diagnostic: GeometryError): SelectionIssue {
	switch (diagnostic.kind) {
		case 'trigger-boundary':
		case 'ambiguous-owner':
			return { kind: 'instructions-overlap', diagnostic };
		case 'invalid-slot':
			return { kind: 'unmappable', diagnostic };
	}
}

function failureIssue(diagnostic: unknown): SelectionIssue {
	return diagnostic instanceof GeometryError
		? geometrySelectionIssue(diagnostic)
		: { kind: 'unexpected', diagnostic };
}

function selectionActions(disabled: Partial<Record<AuthoringMode, string>> = {}): SelectionActions {
	return {
		explain: disabled.explain ? { enabled: false, reason: disabled.explain } : { enabled: true },
		concession: disabled.concession
			? { enabled: false, reason: disabled.concession }
			: { enabled: true }
	};
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

function hasBreakInstructions(
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
	draft: PlaybookDraft,
	geometry: PlaybookGeometryIndex,
	context: BreakPolicyContext,
	concession: Concession | undefined = draft.concessions[0]
): SelectionEligibility {
	return evaluate(() => {
		if (context.index !== index) return { allowed: false, issue: { kind: 'unavailable' } };
		const issue = sourceIssue(index, range);
		if (issue) return { allowed: false, issue };
		if (!concession?.changes[0])
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
			geometry.triggersIntersecting(range, draft.persistedId).length ||
			hasBreakInstructions(context, range, geometry, draft.persistedId)
		)
			return { allowed: false, issue: { kind: 'instructions-overlap' } };
		if (
			triggersIntersect(index, draft.trigger.target, range) ||
			(draft.trigger.target.kind === 'boundary' &&
				range.kind === 'boundary' &&
				shareBoundaryBreak(context, draft.trigger.target, range))
		)
			return { allowed: false, issue: { kind: 'instructions-overlap' } };
		geometry.validateTriggersReplacing(draft.persistedId, [draft.trigger]);
		geometry.validateChanges([concession.changes[0], proposed], draft.persistedId, [draft.trigger]);
		return {
			allowed: true,
			actions: selectionActions({
				explain: 'Choose a new clause to explain.'
			})
		};
	});
}

/** Existing and new instructions use the same selection geometry. */
export function evaluateConcessionAddition(
	index: SourceIndex,
	range: SourceTarget,
	draft: PlaybookDraft,
	geometry: PlaybookGeometryIndex,
	context: BreakPolicyContext
): SelectionEligibility {
	return evaluate(() => {
		if (context.index !== index) return { allowed: false, issue: { kind: 'unavailable' } };
		const issue = sourceIssue(index, range);
		if (issue) return { allowed: false, issue };
		if (hasBreakInstructions(context, range, geometry, draft.persistedId))
			return { allowed: false, issue: { kind: 'instructions-overlap' } };
		geometry.validateTriggersReplacing(draft.persistedId, [draft.trigger]);
		geometry.validateChanges([{ target: range, replacement: [] }], draft.persistedId, [
			draft.trigger
		]);
		return {
			allowed: true,
			actions: selectionActions({
				explain: 'Choose a new clause to explain.'
			})
		};
	});
}

/** Evaluate common eligibility once, then only the concession-specific geometry. */
export function evaluateInitialSelection(
	index: SourceIndex,
	range: SourceTarget,
	geometry: PlaybookGeometryIndex,
	context: BreakPolicyContext
): SelectionEligibility {
	return evaluate(() => {
		if (context.index !== index) return { allowed: false, issue: { kind: 'unavailable' } };
		const issue = sourceIssue(index, range);
		if (issue) return { allowed: false, issue };
		const boundary = structuralBoundary(index, range);
		if (
			geometry.triggersIntersecting(range).length ||
			hasBreakInstructions(context, range, geometry)
		)
			return { allowed: false, issue: { kind: 'instructions-overlap' } };
		let id = 'candidate-trigger';
		while (geometry.triggerIds.has(id)) id += '-';
		const trigger = { id, target: range };
		geometry.validateTriggersReplacing(undefined, [trigger]);
		const disabled: Partial<Record<AuthoringMode, string>> = {};
		try {
			geometry.validateChanges([{ target: range, replacement: [] }], undefined, [trigger]);
		} catch (diagnostic) {
			if (boundary) return { allowed: false, issue: failureIssue(diagnostic) };
			disabled.concession = selectionIssueMessage(failureIssue(diagnostic));
		}
		return { allowed: true, actions: selectionActions(disabled) };
	});
}
