const CARD_GAP = 6;
const SAME_LINE_TOLERANCE = 4;

export interface AnnotationRailLayoutItem {
	id: string;
	anchorTop: number;
	height: number;
	order: number;
}

interface ActiveAnnotationRailItem {
	id: string;
	targetTop: number;
}

export interface AnnotationRailLayout {
	placements: Record<string, number>;
	bottom: number;
}

function orderedLayoutItems(items: ReadonlyArray<AnnotationRailLayoutItem>) {
	const sortedItems = [...items].sort(
		(left, right) => left.anchorTop - right.anchorTop || left.order - right.order
	);
	const groups: Array<{ anchorTop: number; items: AnnotationRailLayoutItem[] }> = [];

	for (const item of sortedItems) {
		const group = groups.at(-1);
		if (!group || Math.abs(item.anchorTop - group.anchorTop) > SAME_LINE_TOLERANCE) {
			groups.push({ anchorTop: item.anchorTop, items: [item] });
			continue;
		}
		group.items.push(item);
	}

	return groups.flatMap((group) => group.items.sort((left, right) => right.order - left.order));
}

function packAroundActiveCard(
	items: ReadonlyArray<AnnotationRailLayoutItem>,
	activeItem: ActiveAnnotationRailItem
): AnnotationRailLayout | null {
	const orderedItems = orderedLayoutItems(items);
	const activeIndex = orderedItems.findIndex((item) => item.id === activeItem.id);
	if (activeIndex === -1) return null;

	const activeLayoutItem = orderedItems[activeIndex];
	const placements: Record<string, number> = {
		[activeLayoutItem.id]: activeItem.targetTop
	};

	let nextTop = placements[activeLayoutItem.id];
	for (let index = activeIndex - 1; index >= 0; index -= 1) {
		const item = orderedItems[index];
		const top = Math.min(item.anchorTop, nextTop - CARD_GAP - item.height);
		placements[item.id] = top;
		nextTop = top;
	}

	let previousBottom = placements[activeLayoutItem.id] + activeLayoutItem.height;
	for (let index = activeIndex + 1; index < orderedItems.length; index += 1) {
		const item = orderedItems[index];
		const top = Math.max(item.anchorTop, previousBottom + CARD_GAP);
		placements[item.id] = top;
		previousBottom = top + item.height;
	}

	const minimumTop = Math.min(...Object.values(placements));
	if (minimumTop < 0) {
		for (const id of Object.keys(placements)) placements[id] -= minimumTop;
	}

	return {
		placements,
		bottom: Math.max(...orderedItems.map((item) => placements[item.id] + item.height))
	};
}

export function packAnnotationRail(
	items: ReadonlyArray<AnnotationRailLayoutItem>,
	activeItem: ActiveAnnotationRailItem | null = null
): AnnotationRailLayout {
	if (activeItem) {
		const activeLayout = packAroundActiveCard(items, activeItem);
		if (activeLayout) return activeLayout;
	}

	const placements: Record<string, number> = {};
	let nextTop = 0;
	for (const item of orderedLayoutItems(items)) {
		const top = Math.max(item.anchorTop, nextTop);
		placements[item.id] = top;
		nextTop = top + item.height + CARD_GAP;
	}

	return {
		placements,
		bottom: items.length > 0 ? nextTop - CARD_GAP : 0
	};
}
