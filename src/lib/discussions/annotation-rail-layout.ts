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

export function packAnnotationRail(
	items: ReadonlyArray<AnnotationRailLayoutItem>,
	activeItem: ActiveAnnotationRailItem | null = null
): AnnotationRailLayout {
	const orderedItems = orderedLayoutItems(items);
	const activeLayoutItem = activeItem && orderedItems.find((item) => item.id === activeItem.id);
	const placements: Record<string, number> = {};
	const activeTop = activeItem?.targetTop ?? 0;
	const activeBottom = activeLayoutItem ? activeTop + activeLayoutItem.height : 0;
	if (activeLayoutItem) placements[activeLayoutItem.id] = activeTop;

	let bottom = activeBottom;
	let nextTop = 0;
	for (const item of orderedItems) {
		if (item === activeLayoutItem) continue;
		let top = Math.max(item.anchorTop, nextTop);
		if (
			activeLayoutItem &&
			top < activeBottom + CARD_GAP &&
			top + item.height + CARD_GAP > activeTop
		)
			top = activeBottom + CARD_GAP;
		placements[item.id] = top;
		bottom = Math.max(bottom, top + item.height);
		nextTop = top + item.height + CARD_GAP;
	}

	return { placements, bottom };
}
