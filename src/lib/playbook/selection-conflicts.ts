import type { DocumentOverlayItem } from './document-overlay';
import type { ValidationSourceFacts } from '../document/validation-source';
import type { ConcessionSelection } from './model';
import { createChangeConflictChecker, iterateChangeConflicts } from './conflicts';
import { complete } from '../document/iteration';

export function selectedItems(
	items: readonly DocumentOverlayItem[],
	selection: ConcessionSelection
) {
	return items.flatMap((item) => {
		const selected = selection[item.itemId];
		if (selected === undefined) return [];
		const concession = item.concessions.find((c) => c.id === selected);
		return concession ? [{ itemId: item.itemId, concession }] : [];
	});
}

export function conflictsForConcession(
	index: ValidationSourceFacts,
	items: readonly DocumentOverlayItem[],
	selection: ConcessionSelection,
	itemId: string,
	concessionId: string,
	conflicts = createChangeConflictChecker(index)
) {
	const candidate = items
		.find((i) => i.itemId === itemId)
		?.concessions.find((c) => c.id === concessionId);
	if (!candidate) return [];
	return selectedItems(items, selection).filter(
		(a) =>
			a.itemId !== itemId &&
			candidate.changes.some((x) => a.concession.changes.some((y) => conflicts(x, y)))
	);
}

export function activeConflicts(
	index: ValidationSourceFacts,
	items: readonly DocumentOverlayItem[],
	selection: ConcessionSelection
) {
	const active = selectedItems(items, selection);
	const changes = active.flatMap((item) => item.concession.changes);
	const groups = active.flatMap((item) => item.concession.changes.map(() => item.itemId));
	const conflicts = complete(iterateChangeConflicts(index, changes, { groups }));
	const itemIds = new Set([...conflicts].map((i) => groups[i]));
	return active.filter((item) => itemIds.has(item.itemId));
}
