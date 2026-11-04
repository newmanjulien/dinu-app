import type { ContractChange, PlaybookItemRecord, SourceTarget, Trigger } from './model';

export type DocumentAnnotation = {
	id: string;
	itemId: string;
	range: SourceTarget;
} & (
	| { kind: 'trigger'; triggerId: string }
	| { kind: 'concession-effect'; concessionId: string; changeIndex: number }
);

export type AnnotationMembership = DocumentAnnotation & { applied?: boolean };

export const triggerAnnotationId = (itemId: string, triggerId: string) =>
	JSON.stringify(['trigger', itemId, triggerId]);

export function documentAnnotations(
	record: Pick<PlaybookItemRecord, '_id' | 'trigger' | 'concessions'>
): DocumentAnnotation[] {
	return [
		{
			id: triggerAnnotationId(record._id, record.trigger.id),
			kind: 'trigger',
			itemId: record._id,
			triggerId: record.trigger.id,
			range: record.trigger.range
		},
		...record.concessions.flatMap((concession) =>
			concession.changes.slice(1).map((change, i): DocumentAnnotation => ({
				id: JSON.stringify(['concession-effect', record._id, concession.id, i + 1]),
				kind: 'concession-effect',
				itemId: record._id,
				concessionId: concession.id,
				changeIndex: i + 1,
				range: change.range
			}))
		)
	];
}

export interface AnnotationSegment {
	target: AnnotationMembership | undefined;
	membershipKey: string;
	membershipIds: readonly string[];
}

const segments = new WeakMap<readonly AnnotationMembership[], AnnotationSegment>();
const EMPTY_MEMBERSHIPS: readonly AnnotationMembership[] = [];

/** Rendering and geometry use the same boundaries and deterministic interaction target. */
export function annotationSegment(
	annotations: readonly AnnotationMembership[] = EMPTY_MEMBERSHIPS
): AnnotationSegment {
	const cached = segments.get(annotations);
	if (cached) return cached;
	const priority = (annotation: AnnotationMembership) =>
		annotation.kind === 'trigger' ? 0 : annotation.applied ? 1 : 2;
	const target = annotations.reduce<AnnotationMembership | undefined>(
		(best, annotation) =>
			!best ||
			priority(annotation) < priority(best) ||
			(priority(annotation) === priority(best) && annotation.id < best.id)
				? annotation
				: best,
		undefined
	);
	const membershipIds = [...new Set(annotations.map((annotation) => annotation.id))].sort();
	const segment = {
		target,
		membershipKey: JSON.stringify([target?.id, membershipIds]),
		membershipIds
	};
	segments.set(annotations, segment);
	return segment;
}

export type DocumentOverlayItem = {
	itemId: string;
	annotations: DocumentAnnotation[];
	trigger: Trigger;
	concessions: { id: string; changes: ContractChange[] }[];
};

/** Only this projection may contribute Playbook data to render-source identity. */
export function toDocumentOverlay(record: PlaybookItemRecord): DocumentOverlayItem {
	return {
		itemId: record._id,
		annotations: documentAnnotations(record),
		trigger: record.trigger,
		concessions: record.concessions.map(({ id, changes }) => ({ id, changes }))
	};
}
