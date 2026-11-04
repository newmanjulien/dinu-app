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

export interface PaginationOptions {
	capacity?: (pageIndex: number) => number;
}

export type PaginationStep =
	| { type: 'geometry'; block: PreparedBlock; detail: GeometryDetail }
	| { type: 'page'; page: PaginatedPage }
	| undefined;

/** A yielded page is closed: subsequent geometry cannot change its placements. */
export function* iteratePreparedDocument(
	blocks: readonly PreparedBlock[],
	profiles: LayoutProfiles,
	{ capacity = pageCapacity }: PaginationOptions = {}
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
	let page: { number: number; placements: LayoutPlacement[] } = { number: 1, placements: [] };
	let remaining = capacityAt(0);
	const fits = (height: number) => fitsPage(height, remaining);
	function* newPage(): Generator<PaginationStep, void> {
		if (!page.placements.length) throw new Error('Pagination cannot emit an empty page.');
		yield { type: 'page', page };
		page = { number: page.number + 1, placements: [] };
		remaining = capacityAt(page.number - 1);
	}
	function accept(prepared: PreparedBlock, fragment: PageFragment, height: number) {
		const carriesBoundaries =
			fragment.type === 'heading' || (fragment.type === 'paragraph' && fragment.isFinal);
		const boundaries = carriesBoundaries ? prepared.boundariesAfter ?? [] : [];
		page.placements.push({
			prepared,
			fragment,
			...(boundaries.length ? { structuralBoundaries: boundaries } : {})
		});
		remaining -= height;
	}
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		const whole = block.fragment;
		yield undefined;
		let profile = yield* profileFor(block);
		if (whole.type === 'heading' && profile.kind === 'heading') {
			const next = blocks[index + 1];
			const following =
				next?.fragment.type === 'paragraph' ? yield* profileFor(next, 'exact') : undefined;
			if (following?.kind === 'paragraph' && !following.lines)
				throw new Error('Heading lookahead requires exact observed lines.');
			const required =
				profile.outerHeight +
				(following?.kind === 'paragraph' && following.lines
					? paragraphFirstLineHeight({ ...following, lines: following.lines })
					: 0);
			if (!fits(required) && page.placements.length) yield* newPage();
			if (!fits(required))
				throw new Error(
					`Heading "${whole.anchor}" cannot fit with its required spacing and following line on an empty page.`
				);
			accept(block, whole, profile.outerHeight);
		} else if (whole.type === 'table' && profile.kind === 'table') {
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
			// Preserve the move-whole-table rule before considering body-row splits.
			if (!fits(height) && page.placements.length && fitsPage(height, capacityAt(page.number)))
				yield* newPage();
			if (!rowCount && !fits(height) && page.placements.length) yield* newPage();
			if (fits(height)) {
				accept(block, table, height);
				continue;
			}
			if (!rowCount) throw new Error(`Table header in "${whole.blockKey}" exceeds an empty page.`);
			const headers = whole.rows.slice(0, whole.headerRowCount);
			for (let start = 0; start < rowCount;) {
				const end = maximumTableRowEnd(profile, start, remaining);
				if (end === start) {
					if (!page.placements.length)
						throw new Error(
							`Table headers and body row ${start} in "${whole.blockKey}" exceed an empty page.`
						);
					yield* newPage();
					continue;
				}
				accept(
					block,
					{
						...table,
						interval: { start, end },
						rows: [
							...headers,
							...whole.rows.slice(whole.headerRowCount + start, whole.headerRowCount + end)
						]
					},
					tableFragmentHeight(profile, start, end)
				);
				start = end;
				if (start < rowCount) yield* newPage();
			}
		} else if (whole.type === 'paragraph' && profile.kind === 'paragraph') {
			const outerHeight = profile.marginBlockStart + profile.contentHeight + profile.marginBlockEnd;
			if (fits(outerHeight)) {
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
				if (!fits(height) && page.placements.length) yield* newPage();
				if (!fits(height))
					throw new Error(`Paragraph spacing in "${whole.blockKey}" exceeds an empty page.`);
				accept(block, paragraphSlice(whole, 0, whole.tokens.length), height);
				continue;
			}
			for (let start = 0; start < exact.lines.length;) {
				const end = maximumParagraphLineEnd(exact, start, remaining);
				if (end === start) {
					if (!page.placements.length)
						throw new Error(
							`Visual line ${start} and its spacing in "${whole.blockKey}" exceed an empty page.`
						);
					yield* newPage();
					continue;
				}
				accept(
					block,
					paragraphSlice(whole, exact.lines[start].startToken, exact.lines[end - 1].endToken),
					paragraphFragmentHeight(exact, start, end)
				);
				start = end;
				if (start < exact.lines.length) yield* newPage();
			}
		}
	}
	if (page.placements.length) yield { type: 'page', page };
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
