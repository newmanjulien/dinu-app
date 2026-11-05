import { conflictsForConcession } from '$lib/playbook/selection-conflicts';
import type { PreparedBlock } from '../pagination/prepare';
import { iterateIncrementalDocument, type PaginationHistory } from '../pagination/incremental';
import { hasExactGeometry, type GeometryDetail } from '../pagination/profile';
import type { DocumentArtifacts } from './artifacts';
import type { LayoutProfiler } from '../pagination/profiler';
import type { RenderSnapshot } from './types';

interface GeometryWork {
	focused: boolean;
	block: PreparedBlock;
	detail: GeometryDetail;
	request: ReturnType<LayoutProfiler['createRequest']>;
}

/** Private cursors share completed immutable content and tokens with foreground work.
 * Pagination also discovers newly split unchanged paragraphs after an insertion/removal.
 */
function* alternatives(
	snapshot: RenderSnapshot,
	artifacts: DocumentArtifacts,
	profiler: LayoutProfiler,
	checkCurrent: () => void,
	focusedItemId?: string,
	history?: PaginationHistory
): Generator<GeometryWork | undefined, void> {
	const { source, concessions } = snapshot;
	const composer = artifacts.createComposer();
	const preparation = artifacts.createPreparation();
	const items = [...source.items].sort(
		(a, b) => Number(b.itemId === focusedItemId) - Number(a.itemId === focusedItemId)
	);
	for (const item of items) {
		const choices: (string | undefined)[] = item.concessions.map((choice) => choice.id);
		if (concessions[item.itemId] !== undefined) choices.unshift(undefined);
		for (const choice of choices) {
			if (choice === concessions[item.itemId]) continue;
			try {
				if (
					choice !== undefined &&
					conflictsForConcession(source.sourceIndex, source.items, concessions, item.itemId, choice)
						.length
				)
					continue;
				const selection = { ...concessions };
				if (choice === undefined) delete selection[item.itemId];
				else selection[item.itemId] = choice;
				const prepared: PreparedBlock[] = [];
				for (const block of composer.iterate({
					items: source.items,
					activeConcessions: selection,
					view: 'redline'
				})) {
					if (block) prepared.push(yield* preparation.iterate(block));
					yield undefined;
				}
				const request = profiler.createRequest(
					snapshot.layoutEpoch,
					undefined,
					undefined,
					checkCurrent
				);
				for (const step of iterateIncrementalDocument(prepared, request.profiles, history)) {
					if (step?.type === 'geometry')
						yield {
							block: step.block,
							detail: step.detail,
							request,
							focused: item.itemId === focusedItemId
						};
					else yield undefined;
				}
			} catch {
				// Saved alternatives and missing optional geometry never affect foreground validation.
			}
			yield undefined;
		}
	}
}

/** Warm content, tokens and demand-driven geometry. Never publish pages or snapshots. */
export function prewarmSavedConcessions(
	snapshot: RenderSnapshot,
	profiler: LayoutProfiler,
	artifacts: DocumentArtifacts,
	focusedItemId?: string,
	history?: PaginationHistory
): () => void {
	const abort = new AbortController();
	const release = profiler.trackAlternative(abort);
	const cancel = () => abort.abort(artifacts.signal.reason);
	if (artifacts.signal.aborted) cancel();
	else artifacts.signal.addEventListener('abort', cancel, { once: true });
	const current = () => !abort.signal.aborted && profiler.epoch === snapshot.layoutEpoch;
	const checkCurrent = () => {
		if (!current()) throw new Error('Alternative preparation cancelled.');
	};
	const blocks = alternatives(snapshot, artifacts, profiler, checkCurrent, focusedItemId, history);
	async function run() {
		try {
			let done = false;
			let queued: ReturnType<typeof blocks.next> | undefined;
			while (!done && current()) {
				await profiler.scheduler.run(
					() => 'alternative',
					() => {
						checkCurrent();
						const started = performance.now();
						do {
							const next = queued ?? blocks.next();
							queued = undefined;
							if (next.done) {
								done = true;
								return;
							}
							if (!next.value) continue;
							const { block, detail, request, focused } = next.value;
							const cached = profiler.cache.get(snapshot.layoutEpoch, block.geometryFingerprint);
							// Focused choices may replace ordinary optional shapes; current geometry stays protected.
							if (!focused && !cached && profiler.cache.availableWarmSlots <= 0) continue;
							request.resolve(block, detail, (upgrade) => {
								queued = blocks.next();
								if (
									queued.value?.block === block &&
									queued.value.request === request &&
									queued.value.detail === 'exact'
								) {
									upgrade();
									queued = blocks.next();
								}
							});
							if (cached && (detail === 'bounds' || hasExactGeometry(cached))) continue;
							// Release the shared surface between geometry requests, even when a read overruns.
							return;
						} while (performance.now() - started < 4);
					},
					abort.signal
				);
			}
		} catch {
			/* Layout teardown and foreground work cancel optional preparation. */
		} finally {
			release();
			artifacts.signal.removeEventListener('abort', cancel);
			blocks.return(undefined);
		}
	}
	void run();
	return () => {
		abort.abort();
		artifacts.signal.removeEventListener('abort', cancel);
		release();
		blocks.return(undefined);
	};
}
