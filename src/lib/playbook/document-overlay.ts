import type { DeepReadonly } from '../immutable';
import type { ContractChange, ContractItemRecord, SourceTarget, Trigger } from './model';

export type DocumentAnnotation = {
	id: string;
	itemId: string;
	target: SourceTarget;
	pending?: boolean;
} & (
	| { kind: 'trigger'; triggerId: string }
	| { kind: 'concession-effect'; concessionId: string; changeIndex: number }
);

export type AnnotationMembership = DocumentAnnotation & { applied?: boolean };

export const triggerAnnotationId = (renderKey: string) => JSON.stringify(['trigger', renderKey]);

export function documentAnnotations(record: {
	_id: string;
	renderKey?: string;
	trigger: Trigger;
	concessions: readonly { id: string; changes: readonly { target: SourceTarget }[] }[];
}): DocumentAnnotation[] {
	return [
		{
			id: triggerAnnotationId(record.renderKey ?? record._id),
			kind: 'trigger',
			itemId: record._id,
			triggerId: record.trigger.id,
			target: record.trigger.target
		},
		...record.concessions.flatMap((concession) =>
			concession.changes.slice(1).map((change, i): DocumentAnnotation => ({
				id: JSON.stringify([
					'concession-effect',
					record.renderKey ?? record._id,
					concession.id,
					i + 1
				]),
				kind: 'concession-effect',
				itemId: record._id,
				concessionId: concession.id,
				changeIndex: i + 1,
				target: change.target
			}))
		)
	];
}

/** Structural annotation consumers need membership and targets, never replacement bodies. */
export type DocumentAnnotationItem = {
	itemId: string;
	annotations: readonly DocumentAnnotation[];
};

export type DocumentOverlayItem = DocumentAnnotationItem & {
	trigger: Trigger;
	concessions: DeepReadonly<{ id: string; changes: ContractChange[] }[]>;
};

/** Only this projection may contribute Playbook data to render-source identity. */
export function toDocumentOverlay(record: DeepReadonly<ContractItemRecord>): DocumentOverlayItem {
	return {
		itemId: record._id,
		annotations: documentAnnotations(record),
		trigger: record.trigger,
		concessions: record.concessions.map(({ id, changes }) => ({ id, changes }))
	};
}
