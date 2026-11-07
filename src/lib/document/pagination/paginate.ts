import { paragraphSlice, type PreparedBlock } from './prepare';
import { fitsPage, pageCapacity } from './page-format';
import {
	maximumParagraphLineEnd,
	maximumTableRowEnd,
	paragraphFirstLineHeight,
	paragraphFragmentHeight,
	tableFragmentHeight,
	type GeometryDetail,
	type ParagraphLayoutProfile,
	type LayoutProfiles
} from './profile';
import type { LayoutPlacement, PageFragment, PaginatedPage } from './types';

export interface PaginationCheckpoint {
	readonly pageNumber: number;
	readonly blockIndex: number;
	readonly block: PreparedBlock | undefined;
	/** Paragraph token or table body-row offset at this page boundary. */
	readonly offset: number;
}

export interface PaginationOptions {
	capacity?: (pageIndex: number) => number;
	start?: PaginationCheckpoint;
}

export type PaginationStep =
	| { type: 'geometry'; block: PreparedBlock; detail: GeometryDetail }
	| { type: 'page'; page: PaginatedPage; next: PaginationCheckpoint }
	| undefined;

/** A yielded page is closed: subsequent geometry cannot change its placements. */
export function* iteratePreparedDocument(
	blocks: readonly PreparedBlock[],
	profiles: LayoutProfiles,
	{ capacity = pageCapacity, start }: PaginationOptions = {}
): Generator<PaginationStep, void> {
	if (!blocks.length) return;
	const capacityAt = (pageIndex: number) => {
		const value = capacity(pageIndex);
		if (!Number.isFinite(value) || value <= 0)
			throw new Error('Pagination requires a finite, positive page capacity.');
		return value;
	};
	function* profileFor(
		block: PreparedBlock,
		detail: GeometryDetail = 'bounds'
	): Generator<PaginationStep, NonNullable<ReturnType<LayoutProfiles['get']>>> {
		const cached = profiles.get(block);
		if (!cached || (detail === 'exact' && cached.kind === 'paragraph' && !cached.lines))
			yield { type: 'geometry', block, detail };
		const profile = profiles.get(block);
		if (!profile || profile.kind !== block.fragment.type)
			throw new Error(`Missing or mismatched layout profile for "${block.fragment.blockKey}".`);
		return profile;
	}
	const followingHeights = new Map<number, number>();
	/** Keep headings and collapsed blanks with the first actual body line or table row. */
	function* followingHeight(index: number): Generator<PaginationStep, number> {
		const prefix: { index: number; height: number }[] = [];
		let height = 0;
		for (; index < blocks.length; index++) {
			const cached = followingHeights.get(index);
			if (cached !== undefined) {
				height = cached;
				break;
			}
			const next = blocks[index];
			const profile = yield* profileFor(
				next,
				next.fragment.type === 'paragraph' ? 'exact' : 'bounds'
			);
			if (profile.kind === 'paragraph') {
				if (!profile.lines) throw new Error('Heading lookahead requires exact observed lines.');
				if (next.fragment.type === 'paragraph' && next.fragment.keepWithNext) {
					prefix.push({
						index,
						height: paragraphFragmentHeight(
							{ ...profile, lines: profile.lines },
							0,
							profile.lines.length
						)
					});
					continue;
				}
				if (!profile.lines.length) {
					prefix.push({
						index,
						height: paragraphFragmentHeight({ ...profile, lines: profile.lines }, 0, 0)
					});
					continue;
				}
				height = paragraphFirstLineHeight({ ...profile, lines: profile.lines });
			} else {
				height = tableFragmentHeight(profile, 0, Math.min(1, profile.bodyRowHeights.length));
			}
			followingHeights.set(index, height);
			break;
		}
		for (let offset = prefix.length - 1; offset >= 0; offset--) {
			height += prefix[offset].height;
			followingHeights.set(prefix[offset].index, height);
		}
		return height;
	}
	const checkpoint = (blockIndex: number, offset = 0): PaginationCheckpoint => ({
		pageNumber: page.number + 1,
		blockIndex,
		block: blocks[blockIndex],
		offset
	});
	let page: { number: number; placements: LayoutPlacement[] } = {
		number: start?.pageNumber ?? 1,
		placements: []
	};
	let remaining = capacityAt(page.number - 1);
	const fits = (height: number) => fitsPage(height, remaining);
	function* newPage(blockIndex: number, offset = 0): Generator<PaginationStep, void> {
		if (!page.placements.length) throw new Error('Pagination cannot emit an empty page.');
		yield { type: 'page', page, next: checkpoint(blockIndex, offset) };
		page = { number: page.number + 1, placements: [] };
		remaining = capacityAt(page.number - 1);
	}
	function accept(prepared: PreparedBlock, fragment: PageFragment, height: number) {
		const carriesBoundaries = fragment.type === 'paragraph' && fragment.isFinal;
		const boundaries = carriesBoundaries ? (prepared.boundariesAfter ?? []) : [];
		page.placements.push({
			prepared,
			fragment,
			...(boundaries.length ? { structuralBoundaries: boundaries } : {})
		});
		remaining -= height;
	}
	for (let index = start?.blockIndex ?? 0; index < blocks.length; index++) {
		const offset = index === start?.blockIndex ? start.offset : 0;
		const block = blocks[index];
		const whole = block.fragment;
		yield undefined;
		const profile = yield* profileFor(block);
		if (whole.type === 'table' && profile.kind === 'table') {
			const rowCount = whole.rows.length - whole.headerRowCount;
			if (
				profile.headerRowCount !== whole.headerRowCount ||
				profile.bodyRowHeights.length !== rowCount
			)
				throw new Error(`Table layout profile does not match "${whole.blockKey}".`);
			const height = tableFragmentHeight(profile, 0, rowCount);
			const table = {
				...whole,
				interval: { start: 0, end: rowCount },
				columnWidths: profile.columnWidths
			};
			const preceding = page.placements.at(-1)?.fragment;
			// Preserve the move-whole-table rule before considering body-row splits.
			if (
				!offset &&
				!fits(height) &&
				page.placements.length &&
				!(preceding?.type === 'paragraph' && preceding.keepWithNext) &&
				fitsPage(height, capacityAt(page.number))
			)
				yield* newPage(index);
			if (!rowCount && !fits(height) && page.placements.length) yield* newPage(index);
			if (!offset && fits(height)) {
				accept(block, table, height);
				continue;
			}
			if (!rowCount) throw new Error(`Table header in "${whole.blockKey}" exceeds an empty page.`);
			const headers = whole.rows.slice(0, whole.headerRowCount);
			for (let start = offset; start < rowCount;) {
				const end = maximumTableRowEnd(profile, start, remaining);
				if (end === start) {
					if (!page.placements.length)
						throw new Error(
							`Table headers and body row ${start} in "${whole.blockKey}" exceed an empty page.`
						);
					yield* newPage(index, start);
					continue;
				}
				accept(
					block,
					{
						...table,
						isFinal: end === rowCount,
						interval: { start, end },
						rows: [
							...headers,
							...whole.rows.slice(whole.headerRowCount + start, whole.headerRowCount + end)
						]
					},
					tableFragmentHeight(profile, start, end)
				);
				start = end;
				if (start < rowCount) yield* newPage(index, start);
			}
		} else if (whole.type === 'paragraph' && profile.kind === 'paragraph') {
			const outerHeight = profile.marginBlockStart + profile.contentHeight + profile.marginBlockEnd;
			if (!offset && whole.keepWithNext) {
				const required = outerHeight + (yield* followingHeight(index + 1));
				// Placement is a preference. Impossible groups/chains use ordinary line splitting.
				if (
					!fits(required) &&
					page.placements.length &&
					fitsPage(required, capacityAt(page.number))
				)
					yield* newPage(index);
			}
			if (!offset && fits(outerHeight)) {
				if (profile.tokenCount !== whole.tokens.length)
					throw new Error(`Paragraph layout profile does not match "${whole.blockKey}".`);
				accept(block, paragraphSlice(whole, 0, whole.tokens.length), outerHeight);
				continue;
			}
			const detailed = yield* profileFor(block, 'exact');
			if (detailed.kind !== 'paragraph' || !detailed.lines)
				throw new Error('Paragraph splitting requires exact observed lines.');
			const exact: ParagraphLayoutProfile = { ...detailed, lines: detailed.lines };
			if (exact.tokenCount !== whole.tokens.length)
				throw new Error(`Paragraph layout profile does not match "${whole.blockKey}".`);
			if (!exact.lines.length) {
				const height = paragraphFragmentHeight(exact, 0, 0);
				if (!fits(height) && page.placements.length) yield* newPage(index);
				if (!fits(height))
					throw new Error(`Paragraph spacing in "${whole.blockKey}" exceeds an empty page.`);
				accept(block, paragraphSlice(whole, 0, whole.tokens.length), height);
				continue;
			}
			const firstLine = offset ? exact.lines.findIndex((line) => line.startToken === offset) : 0;
			if (firstLine < 0) throw new Error('Invalid paragraph continuation checkpoint.');
			for (let start = firstLine; start < exact.lines.length;) {
				const end = maximumParagraphLineEnd(exact, start, remaining);
				if (end === start) {
					if (!page.placements.length)
						throw new Error(
							`Visual line ${start} and its spacing in "${whole.blockKey}" exceed an empty page.`
						);
					yield* newPage(index, exact.lines[start].startToken);
					continue;
				}
				accept(
					block,
					paragraphSlice(whole, exact.lines[start].startToken, exact.lines[end - 1].endToken),
					paragraphFragmentHeight(exact, start, end)
				);
				start = end;
				if (start < exact.lines.length) yield* newPage(index, exact.lines[start].startToken);
			}
		}
	}
	if (page.placements.length) yield { type: 'page', page, next: checkpoint(blocks.length) };
}

/** Synchronous compatibility entry point for callers with complete geometry. */
export function paginatePreparedDocument(
	blocks: readonly PreparedBlock[],
	profiles: LayoutProfiles,
	options: PaginationOptions = {}
): PaginatedPage[] {
	const pages: PaginatedPage[] = [];
	for (const step of iteratePreparedDocument(blocks, profiles, options)) {
		if (step?.type === 'geometry')
			throw new Error(`Missing layout profile for "${step.block.fragment.blockKey}".`);
		if (step?.type === 'page') pages.push(step.page);
	}
	return pages;
}
