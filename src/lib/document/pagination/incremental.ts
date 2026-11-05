import {
	iteratePreparedDocument,
	type PaginationCheckpoint,
	type PaginationOptions,
	type PaginationStep
} from './paginate';
import type { PreparedBlock } from './prepare';
import type { LayoutProfiles } from './profile';
import type { PaginatedPage } from './types';

export interface PaginationHistory {
	readonly blocks: readonly PreparedBlock[];
	readonly pages: readonly PaginatedPage[];
	/** Entry i is the start of page i + 1, including a terminal boundary. */
	readonly checkpoints: readonly PaginationCheckpoint[];
}
export interface PaginationMetrics {
	paginationRestartPage: number;
	paginationStopPage: number;
}
export const firstCheckpoint = (blocks: readonly PreparedBlock[]): PaginationCheckpoint => ({
	pageNumber: 1,
	blockIndex: 0,
	block: blocks[0],
	offset: 0
});

/** Immutable prepared identity proves equality of content, provenance and structural boundaries.
 * The caller only supplies history from the same source and layout epoch.
 */
export function* iterateIncrementalDocument(
	blocks: readonly PreparedBlock[],
	profiles: LayoutProfiles,
	previous?: PaginationHistory,
	metrics?: PaginationMetrics,
	options: Omit<PaginationOptions, 'start'> = {}
): Generator<PaginationStep, void> {
	let prefix = 0;
	if (previous) {
		while (prefix < blocks.length && blocks[prefix] === previous.blocks[prefix]) {
			if (++prefix % 128 === 0) yield undefined;
		}
	}
	let restart = 0;
	if (previous && prefix) {
		if (prefix === blocks.length && prefix === previous.blocks.length)
			restart = previous.pages.length;
		else {
			const preceding = blocks[prefix - 1];
			restart = previous.pages.findIndex((page) =>
				page.placements.some((p) => p.prepared === preceding)
			);
			if (restart < 0) restart = 0;
			// A heading may have moved to this page only to keep with the old next line.
			// Changed/deleted lookahead can let it move back onto the preceding page.
			if (preceding.fragment.type === 'heading' && restart > 0) restart--;
		}
	}
	let start = previous?.checkpoints[restart];
	if (
		!start ||
		start.pageNumber !== restart + 1 ||
		start.block !== blocks[start.blockIndex] ||
		start.blockIndex > prefix
	) {
		restart = 0;
		start = firstCheckpoint(blocks);
	}
	if (metrics) {
		metrics.paginationRestartPage = restart + 1;
		metrics.paginationStopPage = 0;
	}
	for (let i = 0; i < restart; i++)
		yield { type: 'page', page: previous!.pages[i], next: previous!.checkpoints[i + 1] };
	if (
		previous &&
		restart === previous.pages.length &&
		prefix === blocks.length &&
		prefix === previous.blocks.length
	) {
		if (metrics) metrics.paginationStopPage = restart + 1;
		return;
	}
	let suffix = blocks.length,
		oldSuffix = previous?.blocks.length ?? 0;
	while (
		previous &&
		suffix > prefix &&
		oldSuffix > prefix &&
		blocks[suffix - 1] === previous.blocks[oldSuffix - 1]
	) {
		suffix--;
		oldSuffix--;
		if (suffix % 128 === 0) yield undefined;
	}
	for (const step of iteratePreparedDocument(blocks, profiles, { ...options, start })) {
		yield step;
		if (step?.type !== 'page' || !previous) continue;
		const next = step.next;
		const old = previous.checkpoints[next.pageNumber - 1];
		if (
			!old ||
			next.blockIndex < suffix ||
			next.block !== old.block ||
			next.offset !== old.offset ||
			old.blockIndex !== oldSuffix + next.blockIndex - suffix
		)
			continue;
		if (metrics) metrics.paginationStopPage = next.pageNumber;
		for (let i = next.pageNumber - 1; i < previous.pages.length; i++) {
			const boundary = previous.checkpoints[i + 1];
			yield {
				type: 'page',
				page: previous.pages[i],
				next: {
					...boundary,
					blockIndex: boundary.blockIndex + suffix - oldSuffix
				}
			};
		}
		return;
	}
}
