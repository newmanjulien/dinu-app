import type { DeepReadonly } from '../immutable';
import type {
	ConcessionSelection,
	ContractChange,
	RepInstructionRecord,
	SourceTarget,
	TemplateAudience,
	TextTrigger,
	Trigger
} from './model';
import type { AttachmentHighlightKind } from '../document/highlights/theme';
import type { ValidationSourceFacts } from '../document/validation-source';
import {
	activeConcessionChanges,
	collectOverlayImpact,
	textRangeOverlapsImpact,
	type OverlayImpactItem
} from './overlay-impact';

export type DocumentAnnotation = {
	id: string;
	itemId: string;
	highlightKind: AttachmentHighlightKind;
	target: SourceTarget;
	pending?: boolean;
} & (
	| { kind: 'trigger'; triggerId: string }
	| { kind: 'concession-effect'; concessionId: string; changeIndex: number }
);

export type AnnotationMembership = DocumentAnnotation & { applied?: boolean };

export const triggerAnnotationId = (renderKey: string) => JSON.stringify(['trigger', renderKey]);

type AnnotationRecord = {
	_id: string;
	renderKey?: string;
	audience: TemplateAudience;
	trigger: Trigger;
	concessions?: readonly { id: string; changes: readonly { target: SourceTarget }[] }[];
};

export function documentAnnotations(record: AnnotationRecord): DocumentAnnotation[] {
	const concessions = record.concessions ?? [];
	const highlightKind: AttachmentHighlightKind =
		record.audience === 'buyer' ? 'buyer-attachment' : 'rep-attachment';
	const key = record.renderKey ?? record._id;
	return [
		{
			id: triggerAnnotationId(key),
			kind: 'trigger',
			itemId: record._id,
			highlightKind,
			triggerId: record.trigger.id,
			target: record.trigger.target
		},
		...concessions.flatMap((concession) =>
			concession.changes.flatMap((change, i): DocumentAnnotation[] =>
				i === 0
					? []
					: [
							{
								id: JSON.stringify(['concession-effect', key, concession.id, i]),
								kind: 'concession-effect',
								itemId: record._id,
								highlightKind,
								concessionId: concession.id,
								changeIndex: i,
								target: change.target
							}
						]
			)
		)
	];
}

/** Structural annotation consumers need membership and targets, never replacement bodies. */
export type DocumentAnnotationItem = {
	itemId: string;
	annotations: readonly DocumentAnnotation[];
};

export type DocumentOverlayItem = DocumentAnnotationItem & {
	audience: 'rep';
	trigger: Trigger;
	concessions: DeepReadonly<{ id: string; changes: ContractChange[] }[]>;
};

export type AppliedOverlay = Pick<DocumentOverlayItem, 'itemId' | 'trigger' | 'concessions'>;

/** Wrap narrow Convex wire overlays for effective-view composition without widening the wire shape. */
export function toAppliedOverlayItems(overlays: readonly AppliedOverlay[]): DocumentOverlayItem[] {
	return overlays.map((overlay) => ({
		...overlay,
		audience: 'rep',
		annotations: []
	}));
}

/** Only this projection may contribute Playbook data to render-source identity. */
export function toDocumentOverlay(record: DeepReadonly<RepInstructionRecord>): DocumentOverlayItem {
	return {
		itemId: record._id,
		audience: 'rep',
		annotations: documentAnnotations(record),
		trigger: record.trigger,
		concessions: record.concessions.map(({ id, changes }) => ({ id, changes }))
	};
}

/** Hide buyer explanations whose template trigger overlaps any applied Playbook concession edit,
 * structurally removed paragraph, or crossed boundary insertion. */
export function filterOverlappedExplanations<T extends { trigger: TextTrigger }>(
	index: ValidationSourceFacts,
	explanations: readonly T[],
	appliedOverlays: readonly OverlayImpactItem[],
	concessions: ConcessionSelection
): T[] {
	if (!explanations.length || !appliedOverlays.length) return [...explanations];
	const activeChanges = activeConcessionChanges(appliedOverlays, concessions);
	if (!activeChanges.length) return [...explanations];
	const impact = collectOverlayImpact(index, activeChanges);
	return explanations.filter(
		(explanation) => !textRangeOverlapsImpact(index, explanation.trigger.target, impact)
	);
}
