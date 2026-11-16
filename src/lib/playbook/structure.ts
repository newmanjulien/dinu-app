import type { ResolvedContractItem } from '../contract/items';
import type { ContractItemId } from '../contract/item-identity';
import type { DeepReadonly } from '../immutable';
import type { Id } from '../../convex/_generated/dataModel';
import { hasMeaningfulReplacement } from '../document/replacement-content';
import type {
	ContractChange,
	RepInstructionRecord,
	SourceTarget,
	Trigger,
	TemplateAudience,
	TemplateItem
} from './model';

/** Wording never belongs to the reactive annotation/validation surface. */
export type ItemStructure = {
	audience: TemplateAudience;
	trigger: Trigger;
	concessions: {
		id: string;
		changes: ChangeStructure[];
	}[];
};
export type ChangeStructure = {
	target: SourceTarget;
	paragraphBreaks: number;
	meaningful: boolean;
};
/** Project actual content once, while preserving paragraph counts for equality/transport. */
export function changeStructure({
	target,
	replacement
}: DeepReadonly<ContractChange>): ChangeStructure {
	return {
		target,
		paragraphBreaks: replacement.filter((atom) => atom.kind === 'paragraph-break').length,
		meaningful: hasMeaningfulReplacement(replacement)
	};
}
export type StructureItem<ItemId extends ContractItemId = Id<'playbookItems'>> = ItemStructure & {
	_id: ItemId;
	_creationTime: number;
	contentRevision: number;
	renderKey: string;
};
export type OwnedStructureItem = StructureItem & {
	_id: Id<'playbookItems'>;
	companyId: Id<'company'>;
};
export type AuthoringWatermark = {
	templateSourceFingerprint: string;
	authoringGeneration: number;
	structuralGeneration: number;
};
export type AuthoringSourceIdentity = {
	templateSourceId: Id<'templateSources'> | null;
	templateSourceFingerprint: string;
};
export type StructureSnapshot = DeepReadonly<
	AuthoringWatermark &
		AuthoringSourceIdentity & {
			ready: boolean;
			items: OwnedStructureItem[];
		}
>;
type ItemIdentity = Pick<
	RepInstructionRecord,
	'_id' | '_creationTime' | 'contentRevision' | 'renderKey'
>;
export type TemplateItemRecord = ItemIdentity & TemplateItem;
type DetailIdentity = {
	_id: Id<'playbookItems'>;
	companyId: Id<'company'>;
	currentRevisionId?: Id<'playbookItemRevisions'>;
	lastOperation?: { id: string; callerId: Id<'profiles'> };
	renderKey: string;
};
export type TemplateDetailRecord = TemplateItemRecord & DetailIdentity;
export type RepInstructionDetailRecord = RepInstructionRecord & DetailIdentity;
/** Stable item content. Only a complete structure snapshot can establish membership. */
export type TemplateContentSnapshot = DeepReadonly<
	AuthoringSourceIdentity & { ready: boolean } & (
			{ status: 'present'; item: TemplateDetailRecord } | { status: 'missing' }
		)
>;
export function playbookStructure(item: {
	readonly trigger: Trigger;
	readonly audience: TemplateAudience;
	readonly concessions?: readonly {
		readonly id: string;
		readonly changes: readonly DeepReadonly<ContractChange>[];
	}[];
}): ItemStructure {
	return {
		audience: item.audience,
		trigger: item.trigger,
		concessions: (item.concessions ?? []).map(({ id, changes }) => ({
			id,
			changes: changes.map(changeStructure)
		}))
	};
}
export function itemStructure<ItemId extends ContractItemId>(
	item:
		| DeepReadonly<
				Pick<
					RepInstructionRecord<ItemId>,
					'_id' | '_creationTime' | 'contentRevision' | 'renderKey' | 'trigger'
				> & { audience: TemplateAudience; concessions?: import('./model').Concession[] }
		  >
		| DeepReadonly<ResolvedContractItem>,
	renderKey = ('renderKey' in item ? item.renderKey : undefined) ?? item._id
): StructureItem<ItemId> {
	return {
		_id: item._id as ItemId,
		_creationTime: item._creationTime,
		contentRevision: item.contentRevision,
		renderKey,
		...playbookStructure(
			'primary' in item
				? {
						audience: 'rep',
						trigger: item.primary,
						concessions: item.choices
					}
				: item
		)
	};
}
