import type { PreparedBlock } from './prepare';
import { fitsPage } from './page-format';

/** CSS-pixel equivalence for observed layout coordinates, never a page-fit allowance. */
export const LAYOUT_COORDINATE_TOLERANCE = 0.01;

export type BlockLayoutProfile = ParagraphBounds | TableLayoutProfile;

/** Request-local content association. Profiles themselves contain no provenance or page state. */
export type LayoutProfiles = ReadonlyMap<PreparedBlock, BlockLayoutProfile>;

export interface ParagraphLine {
	/** Half-open prepared-token interval ending at a complete observed visual line. */
	readonly startToken: number;
	readonly endToken: number;
	/** Allocated line-box coordinates, relative to the paragraph's content top, not glyph bounds. */
	readonly top: number;
	readonly bottom: number;
}

export type GeometryDetail = 'bounds' | 'exact';

export function hasExactGeometry(profile: BlockLayoutProfile): boolean {
	return profile.kind !== 'paragraph' || profile.lines !== undefined;
}

export interface ParagraphBounds {
	readonly kind: 'paragraph';
	readonly tokenCount: number;
	/** Undefined for bounds-only geometry; an empty exact map means collapsed content. */
	readonly lines?: readonly ParagraphLine[];
	readonly marginBlockStart: number;
	readonly marginBlockEnd: number;
	readonly contentHeight: number;
}

export interface ParagraphLayoutProfile extends ParagraphBounds {
	readonly lines: readonly ParagraphLine[];
}

export interface TableLayoutProfile {
	readonly kind: 'table';
	/** Canonical widths under which all header/body row heights were observed. */
	readonly columnWidths: readonly number[];
	readonly marginBlockStart: number;
	readonly marginBlockEnd: number;
	readonly headerRowCount: number;
	readonly headerHeight: number;
	readonly bodyRowHeights: readonly number[];
	/** Outer edge height not included in row boxes (e.g. half of a collapsed border). */
	readonly borderBlockStart: number;
	readonly borderBlockEnd: number;
}

function requireGeometry(condition: boolean, detail: string): asserts condition {
	if (!condition) throw new Error(`Invalid layout profile: ${detail}.`);
}

function nonnegative(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function count(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

/** Validate once at the profiling/cache boundary, before using the pure arithmetic helpers.
 * Numeric validation cannot prove browser observation: the surface must reject a token that
 * spans multiple visual lines rather than manufacture a token boundary inside a line.
 */
export function validateBlockLayoutProfile(profile: BlockLayoutProfile): void {
	switch (profile.kind) {
		case 'paragraph': {
			requireGeometry(count(profile.tokenCount), 'paragraph token count');
			requireGeometry(
				[profile.marginBlockStart, profile.marginBlockEnd, profile.contentHeight].every(
					nonnegative
				),
				'paragraph heights and margins'
			);
			requireGeometry(
				Number.isFinite(profile.marginBlockStart + profile.contentHeight + profile.marginBlockEnd),
				'paragraph outer height'
			);
			if (!profile.lines) return;
			let nextToken = 0;
			let previousBottom = 0;
			for (const line of profile.lines) {
				requireGeometry(
					count(line.startToken) &&
						count(line.endToken) &&
						line.startToken === nextToken &&
						line.endToken <= profile.tokenCount &&
						(line.endToken > line.startToken ||
							(profile.tokenCount === 0 && profile.lines.length === 1)),
					'paragraph line token coverage'
				);
				requireGeometry(
					nonnegative(line.top) &&
						nonnegative(line.bottom) &&
						line.bottom > line.top &&
						Math.abs(line.top - previousBottom) <= LAYOUT_COORDINATE_TOLERANCE,
					'paragraph line boxes must cover content in visual order'
				);
				nextToken = line.endToken;
				previousBottom = line.bottom;
			}
			requireGeometry(
				profile.lines.length === 0 || nextToken === profile.tokenCount,
				'paragraph tokens missing visual lines'
			);
			requireGeometry(
				Math.abs(previousBottom - profile.contentHeight) <= LAYOUT_COORDINATE_TOLERANCE,
				'paragraph content height differs from its line boxes'
			);
			requireGeometry(
				profile.lines.length > 0 || profile.contentHeight === 0,
				'paragraph height without an observed line'
			);
			return;
		}
		case 'table':
			requireGeometry(
				profile.columnWidths.length > 0 &&
					profile.columnWidths.every((width) => nonnegative(width) && width > 0) &&
					Number.isFinite(profile.columnWidths.reduce((sum, width) => sum + width, 0)),
				'table canonical column widths'
			);
			requireGeometry(count(profile.headerRowCount), 'table header row count');
			requireGeometry(
				[
					profile.marginBlockStart,
					profile.marginBlockEnd,
					profile.headerHeight,
					profile.borderBlockStart,
					profile.borderBlockEnd
				].every(nonnegative) &&
					(profile.headerRowCount === 0 ? profile.headerHeight === 0 : profile.headerHeight > 0),
				'table header, margins and border edges'
			);
			requireGeometry(
				profile.bodyRowHeights.every((height) => nonnegative(height) && height > 0),
				'table body row heights'
			);
			requireGeometry(
				Number.isFinite(tableFragmentHeight(profile, 0, profile.bodyRowHeights.length)),
				'table outer height'
			);
			return;
		default:
			throw new Error('Invalid layout profile: unknown block kind.');
	}
}

function requireRange(start: number, end: number, length: number): void {
	if (!count(start) || !count(end) || start > end || end > length)
		throw new RangeError('Layout profile interval is out of bounds.');
}

/** Height of a half-open visual-line range, excluding paragraph margins. */
export function paragraphLineRangeHeight(
	profile: ParagraphLayoutProfile,
	startLine: number,
	endLine: number
): number {
	requireRange(startLine, endLine, profile.lines.length);
	if (startLine === endLine) return 0;
	const top = startLine === 0 ? 0 : profile.lines[startLine].top;
	const bottom =
		endLine === profile.lines.length ? profile.contentHeight : profile.lines[endLine - 1].bottom;
	return bottom - top;
}

/** Only the first fragment retains its CSS start margin; the final fragment gets end spacing.
 * A paragraph without visual lines retains its margins. Other empty ranges emit no fragment.
 */
export function paragraphFragmentHeight(
	profile: ParagraphLayoutProfile,
	startLine: number,
	endLine: number
): number {
	const contentHeight = paragraphLineRangeHeight(profile, startLine, endLine);
	if (startLine === endLine && profile.lines.length > 0) return 0;
	return (
		(startLine === 0 ? profile.marginBlockStart : 0) +
		contentHeight +
		(endLine === profile.lines.length ? profile.marginBlockEnd : 0)
	);
}

/** Height needed to place the first real line (including final spacing for a one-line paragraph). */
export function paragraphFirstLineHeight(profile: ParagraphLayoutProfile): number {
	return profile.lines.length ? paragraphFragmentHeight(profile, 0, 1) : 0;
}

/** Largest exclusive complete-line endpoint, or startLine if no line fits.
 * When all text fits but final spacing does not, the final line moves with that spacing.
 * Fit arithmetic uses fractional CSS pixels without rounding.
 */
export function maximumParagraphLineEnd(
	profile: ParagraphLayoutProfile,
	startLine: number,
	capacity: number
): number {
	requireRange(startLine, startLine, profile.lines.length);
	if (!Number.isFinite(capacity)) throw new RangeError('Layout capacity must be finite.');
	if (startLine === profile.lines.length) return startLine;
	if (fitsPage(paragraphFragmentHeight(profile, startLine, profile.lines.length), capacity))
		return profile.lines.length;
	let low = startLine + 1;
	let high = profile.lines.length - 1;
	let best = startLine;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (fitsPage(paragraphFragmentHeight(profile, startLine, middle), capacity)) {
			best = middle;
			low = middle + 1;
		} else high = middle - 1;
	}
	return best;
}

/** Headers and border edges repeat; the trailing block gap belongs only to the final row. */
export function tableFragmentHeight(
	profile: TableLayoutProfile,
	startRow: number,
	endRow: number
): number {
	requireRange(startRow, endRow, profile.bodyRowHeights.length);
	let height =
		(startRow === 0 ? profile.marginBlockStart : 0) +
		profile.headerHeight +
		profile.borderBlockStart +
		profile.borderBlockEnd +
		(endRow === profile.bodyRowHeights.length ? profile.marginBlockEnd : 0);
	for (let row = startRow; row < endRow; row++) height += profile.bodyRowHeights[row];
	return height;
}

/** Largest exclusive whole-body-row endpoint; startRow means no body row fits.
 * Header-only tables use tableFragmentHeight(profile, 0, 0) directly.
 */
export function maximumTableRowEnd(
	profile: TableLayoutProfile,
	startRow: number,
	capacity: number
): number {
	requireRange(startRow, startRow, profile.bodyRowHeights.length);
	if (!Number.isFinite(capacity)) throw new RangeError('Layout capacity must be finite.');
	let height = tableFragmentHeight(profile, startRow, startRow);
	let endRow = startRow;
	while (endRow < profile.bodyRowHeights.length) {
		const nextHeight = height + profile.bodyRowHeights[endRow];
		const finalGap = endRow + 1 === profile.bodyRowHeights.length ? profile.marginBlockEnd : 0;
		if (!fitsPage(nextHeight + finalGap, capacity)) break;
		height = nextHeight;
		endRow++;
	}
	return endRow;
}
