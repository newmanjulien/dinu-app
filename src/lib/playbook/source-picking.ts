import type { SourceIndex } from '../contract/source-index';
import { structuralBoundary, targetContainers, validateTarget } from '../contract/ranges';
import type { Concession, ContractChange, SourceTarget } from './model';
import type { PlaybookDraft } from './draft';
import { GeometryError, triggersIntersect } from './geometry';
import { changesConflict } from './conflicts';
import { validateChangeGeometry } from './validation';
import type { PlaybookGeometryIndex } from './geometry-index';

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
			return 'Select a continuous passage of adjacent paragraphs, or text within one table cell.';
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
	try {
		targetContainers(index, range);
	} catch {
		return { kind: 'cross-container' };
	}
}

export function evaluateSecondarySelection(
	index: SourceIndex,
	range: SourceTarget,
	draft: PlaybookDraft,
	geometry: PlaybookGeometryIndex,
	concession: Concession | undefined = draft.concessions[0]
): SelectionEligibility {
	return evaluate(() => {
		const issue = sourceIssue(index, range);
		if (issue) return { allowed: false, issue };
		if (!concession?.changes[0])
			throw new Error('Secondary selection requires a composing concession');
		if (geometry.triggersIntersecting(range, draft.persistedId).length)
			return { allowed: false, issue: { kind: 'instructions-overlap' } };
		const proposed: ContractChange = { range, replacement: [] };
		if (changesConflict(index, concession.changes[0], proposed))
			return { allowed: false, issue: { kind: 'primary-change-overlap' } };
		if (triggersIntersect(index, draft.trigger.range, range))
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
	geometry: PlaybookGeometryIndex
): SelectionEligibility {
	return evaluate(() => {
		const issue = sourceIssue(index, range);
		if (issue) return { allowed: false, issue };
		geometry.validateTriggersReplacing(draft.persistedId, [draft.trigger]);
		geometry.validateChanges([{ range, replacement: [] }], draft.persistedId, [draft.trigger]);
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
	geometry: PlaybookGeometryIndex
): SelectionEligibility {
	return evaluate(() => {
		const issue = sourceIssue(index, range);
		if (issue) return { allowed: false, issue };
		const boundary = structuralBoundary(index, range);
		if (geometry.triggersIntersecting(range).length)
			return { allowed: false, issue: { kind: 'instructions-overlap' } };
		let id = 'candidate-trigger';
		while (geometry.triggerIds.has(id)) id += '-';
		geometry.validateTriggersReplacing(undefined, [{ id, range }]);
		try {
			validateChangeGeometry(index, [{ id, range }], [{ range, replacement: [] }]);
			return {
				allowed: true,
				actions: selectionActions(
					boundary ? { explain: 'Select contract text to explain a clause.' } : undefined
				)
			};
		} catch (diagnostic) {
			if (boundary) return { allowed: false, issue: failureIssue(diagnostic) };
			return {
				allowed: true,
				actions: selectionActions({
					concession: selectionIssueMessage(failureIssue(diagnostic))
				})
			};
		}
	});
}
