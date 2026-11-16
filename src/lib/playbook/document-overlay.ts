import type { DeepReadonly } from '../immutable';
import type { ContractChange, SourceTarget, TemplateAudience, Trigger } from './model';

import type { DocumentItemRecord } from '../contract/items';
import type { AttachmentHighlightKind } from '../document/highlights/theme';
export type DocumentAnnotation = {
	id: string;
	itemId: string;
	highlightKind: AttachmentHighlightKind;
	target: SourceTarget;
	pending?: boolean;
	/** Approved buyer-safe geometry has no associated editor or explanation action. */
	passive?: boolean;
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
export function documentAnnotations(
	record:
		| AnnotationRecord
		| {
				_id: string;
				origin: { kind: 'template' | 'proposal' };
				primary: Trigger & { changeIndex: number };
				choices: readonly { id: string; changes: readonly { target: SourceTarget }[] }[];
		  }
): DocumentAnnotation[] {
	if ('origin' in record && record.origin.kind === 'proposal') return [];
	const resolved = 'primary' in record;
	const trigger = resolved ? record.primary : record.trigger;
	const concessions = resolved ? record.choices : (record.concessions ?? []);
	const renderKey = !resolved ? record.renderKey : undefined;
	const primaryIndex = resolved ? record.primary.changeIndex : 0;
	const buyer = resolved ? record.origin.kind === 'proposal' : record.audience === 'buyer';
	const highlightKind = buyer ? 'buyer-attachment' : 'rep-attachment';
	return [
		{
			id: triggerAnnotationId(renderKey ?? record._id),
			kind: 'trigger',
			itemId: record._id,
			highlightKind,
			triggerId: trigger.id,
			target: trigger.target
		},
		...concessions.flatMap((concession) =>
			concession.changes.flatMap((change, i): DocumentAnnotation[] =>
				i === primaryIndex
					? []
					: [
							{
								id: JSON.stringify([
									'concession-effect',
									renderKey ?? record._id,
									concession.id,
									i
								]),
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
	concessions: DeepReadonly<
		{ id: string; changes: (ContractChange & { suppressed?: boolean })[] }[]
	>;
};

/** Only this projection may contribute Playbook data to render-source identity. */
export function toDocumentOverlay(record: DeepReadonly<DocumentItemRecord>): DocumentOverlayItem {
	return {
		itemId: record._id,
		audience: 'rep',
		annotations: documentAnnotations(record),
		trigger: 'primary' in record ? record.primary : record.trigger,
		concessions: ('choices' in record ? record.choices : record.concessions).map(
			({ id, changes }) => ({ id, changes })
		)
	};
}
