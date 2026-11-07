import { CONTRACT_FORMAT } from '$lib/contract/format';

const PAGE_WIDTH = 816;
const HORIZONTAL_PADDING = 96;

export const PAGE_FORMAT = {
	width: PAGE_WIDTH,
	height: 1056,
	horizontalPadding: HORIZONTAL_PADDING,
	firstTopPadding: 116,
	topPadding: 96,
	bottomPadding: 88,
	contentWidth: PAGE_WIDTH - HORIZONTAL_PADDING * 2,
	gap: 16
} as const;

// Bump when production typography, fragment markup or geometry CSS changes.
export const LAYOUT_EPOCH = `document-layout-v10:${JSON.stringify([PAGE_FORMAT, CONTRACT_FORMAT])}`;
export function pageCapacity(pageIndex: number): number {
	return (
		PAGE_FORMAT.height -
		(pageIndex === 0 ? PAGE_FORMAT.firstTopPadding : PAGE_FORMAT.topPadding) -
		PAGE_FORMAT.bottomPadding
	);
}
/** Profile pagination compares fractional CSS pixels without a fit allowance. */
export function fitsPage(height: number, capacity: number): boolean {
	return height <= capacity;
}
