import { resolvePoint, type SourceIndex } from '../contract/source-index';
import { validateRange } from '../contract/ranges';
import type { Concession, ContractChange, SourceRange } from './model';
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
export type SelectionEligibility =
	| { allowed: true; modes: readonly AuthoringMode[]; concessionIssue?: SelectionIssue }
	| { allowed: false; issue: SelectionIssue };
/** Action restrictions stay distinct from source/geometry failures. */
export type SelectionAvailability = SelectionEligibility | { allowed: false; reason: string };

export function selectionIssueMessage(issue: SelectionIssue): string {
	switch (issue.kind) {
		case 'instructions-overlap':
			return "You can't highlight text that already has instructions attached";
		case 'primary-change-overlap':
			return "You can't highlight text this concession already changes.";
		case 'cross-container':
			return 'Select contract text within one clause.';
		case 'unmappable':
			return 'Select contract text within one clause, including any reference in full.';
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

function evaluate(check: () => SelectionEligibility): SelectionEligibility {
	try {
		return check();
	} catch (diagnostic) {
		return { allowed: false, issue: failureIssue(diagnostic) };
	}
}

function sourceIssue(index: SourceIndex, range: SourceRange): SelectionIssue | undefined {
	let start, end;
	try {
		validateRange(index, range);
		start = resolvePoint(index, range.start);
		end = resolvePoint(index, range.end);
	} catch {
		return { kind: 'unmappable' };
	}
	if (start.containerKey !== end.containerKey) return { kind: 'cross-container' };
}

export function evaluateSecondarySelection(
	index: SourceIndex,
	range: SourceRange,
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
		if (draft.triggers.some((trigger) => triggersIntersect(index, trigger.range, range)))
			return { allowed: false, issue: { kind: 'instructions-overlap' } };
		geometry.validateTriggersReplacing(draft.persistedId, draft.triggers);
		geometry.validateChanges([concession.changes[0], proposed], draft.persistedId, draft.triggers);
		return { allowed: true, modes: ['concession'] };
	});
}

/** A saved trigger is allowed to span containers; its first concession change is not. */
export function evaluateConcessionAddition(
	index: SourceIndex,
	range: SourceRange,
	draft: PlaybookDraft,
	geometry: PlaybookGeometryIndex
): SelectionEligibility {
	return evaluate(() => {
		const issue = sourceIssue(index, range);
		if (issue) return { allowed: false, issue };
		geometry.validateTriggersReplacing(draft.persistedId, draft.triggers);
		geometry.validateChanges([{ range, replacement: [] }], draft.persistedId, draft.triggers);
		return { allowed: true, modes: ['concession'] };
	});
}

/** Evaluate common eligibility once, then only the concession-specific geometry. */
export function evaluateInitialSelection(
	index: SourceIndex,
	range: SourceRange,
	geometry: PlaybookGeometryIndex
): SelectionEligibility {
	return evaluate(() => {
		const issue = sourceIssue(index, range);
		if (issue) return { allowed: false, issue };
		if (geometry.triggersIntersecting(range).length)
			return { allowed: false, issue: { kind: 'instructions-overlap' } };
		let id = 'candidate-trigger';
		while (geometry.triggerIds.has(id)) id += '-';
		geometry.validateTriggersReplacing(undefined, [{ id, range }]);
		try {
			validateChangeGeometry(index, [{ id, range }], [{ range, replacement: [] }]);
			return { allowed: true, modes: ['explain', 'concession'] };
		} catch (diagnostic) {
			return { allowed: true, modes: ['explain'], concessionIssue: failureIssue(diagnostic) };
		}
	});
}
