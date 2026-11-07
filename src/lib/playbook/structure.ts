import type { Id } from '../../convex/_generated/dataModel';
import { hasMeaningfulReplacement } from '../contract/replacement-content';
import type { PlaybookItem, PlaybookItemRecord, SourceTarget, Trigger } from './model';

/** Wording never belongs to the reactive annotation/validation surface. */
export type ItemStructure = {
	trigger: Trigger;
	concessions: {
		id: string;
		changes: { target: SourceTarget; paragraphBreaks: number; meaningful: boolean }[];
	}[];
};
export type StructureItem = ItemStructure & {
	_id: Id<'playbookItems'>;
	_creationTime: number;
	companyId: Id<'company'>;
	contentRevision: number;
	renderKey: string;
};
export type AuthoringWatermark = {
	baselineFingerprint: string;
	authoringGeneration: number;
	structuralGeneration: number;
};
export type StructureSnapshot = AuthoringWatermark & {
	ready: boolean;
	items: StructureItem[];
};
export type DetailRecord = PlaybookItemRecord & {
	companyId: Id<'company'>;
	currentRevisionId?: Id<'playbookItemRevisions'>;
	lastOperation?: { id: string; callerId: Id<'profiles'> };
	renderKey: string;
};
export type DetailSnapshot = AuthoringWatermark & { ready: boolean } & (
		{ status: 'present'; item: DetailRecord } | { status: 'missing' }
	);
export function playbookStructure(
	item: Pick<PlaybookItem, 'trigger' | 'concessions'>
): ItemStructure {
	return {
		trigger: item.trigger,
		concessions: item.concessions.map(({ id, changes }) => ({
			id,
			changes: changes.map(({ target, replacement }) => ({
				target,
				paragraphBreaks: replacement.filter((atom) => atom.kind === 'paragraph-break').length,
				meaningful: hasMeaningfulReplacement(replacement)
			}))
		}))
	};
}
export function itemStructure(
	item: PlaybookItemRecord & { companyId?: Id<'company'>; renderKey?: string },
	renderKey = item.renderKey ?? item._id
): StructureItem {
	return {
		_id: item._id,
		_creationTime: item._creationTime,
		companyId: item.companyId!,
		contentRevision: item.contentRevision,
		renderKey,
		...playbookStructure(item)
	};
}
/** Private geometry input only; synthetic replacement content is never a business detail. */
export function structureGeometry(item: ItemStructure): PlaybookItem {
	return {
		trigger: item.trigger,
		approvalPolicy: { kind: 'none' },
		concessions: item.concessions.map(({ id, changes }) => ({
			id,
			tier: 'preferred',
			description: '',
			changes: changes.map(({ target, paragraphBreaks, meaningful }) => ({
				target,
				replacement: [
					...(meaningful ? [{ kind: 'text' as const, text: 'x' }] : []),
					...Array.from({ length: paragraphBreaks }, () => ({ kind: 'paragraph-break' as const }))
				]
			}))
		}))
	};
}
