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
	orderedIds: string[];
}

function orderedLayoutItems(
	items: ReadonlyArray<AnnotationRailLayoutItem>,
	orderedIds?: ReadonlyArray<string>
) {
	if (orderedIds?.length === items.length) {
		const ranks = new Map(orderedIds.map((id, index) => [id, index]));
		if (items.every((item) => ranks.has(item.id)))
			return [...items].sort((left, right) => ranks.get(left.id)! - ranks.get(right.id)!);
	}
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
	activeItem: ActiveAnnotationRailItem | null = null,
	orderedIds?: ReadonlyArray<string>
): AnnotationRailLayout {
	const orderedItems = orderedLayoutItems(items, orderedIds);
	const tops: number[] = [];
	let nextTop = 0;
	for (const item of orderedItems) {
		const top = Math.max(item.anchorTop, nextTop);
		tops.push(top);
		nextTop = top + item.height + CARD_GAP;
	}

	const selectedIndex = activeItem
		? orderedItems.findIndex((item) => item.id === activeItem.id)
		: -1;
	if (selectedIndex >= 0 && activeItem) {
		let minimumSelectedTop = 0;
		for (let index = 0; index < selectedIndex; index++) {
			minimumSelectedTop += orderedItems[index].height + CARD_GAP;
		}
		tops[selectedIndex] = Math.max(0, activeItem.targetTop, minimumSelectedTop);

		for (let index = selectedIndex - 1; index >= 0; index--) {
			tops[index] = Math.min(tops[index], tops[index + 1] - orderedItems[index].height - CARD_GAP);
		}
		for (let index = selectedIndex + 1; index < orderedItems.length; index++) {
			tops[index] = Math.max(
				orderedItems[index].anchorTop,
				tops[index - 1] + orderedItems[index - 1].height + CARD_GAP
			);
		}
	}

	const placements: Record<string, number> = {};
	let bottom = 0;
	for (let index = 0; index < orderedItems.length; index++) {
		const item = orderedItems[index];
		placements[item.id] = tops[index];
		bottom = Math.max(bottom, tops[index] + item.height);
	}
	return { placements, bottom, orderedIds: orderedItems.map((item) => item.id) };
}
