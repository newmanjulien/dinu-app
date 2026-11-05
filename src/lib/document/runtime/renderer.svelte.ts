import { tick } from 'svelte';
import type { CompositionRequest } from '$lib/contract/composition-artifacts';
import type { Priority } from './scheduler';
import type { LayoutProfiles } from '../pagination/profile';
import type { ContractCompositionEngine } from '$lib/contract/compose';
import type { ResolvedBlock } from '$lib/contract/model';
import { DocumentArtifacts } from './artifacts';
import { sameSelection, type ContractChange } from '$lib/playbook/model';
import {
	firstCheckpoint,
	iterateIncrementalDocument,
	type PaginationHistory
} from '../pagination/incremental';
import { iterateReconciledPages } from '../pagination/reconcile';
import { type LayoutProfiler, StaleLayoutProfileError } from '../pagination/profiler';
import { type PreparedBlock } from '../pagination/prepare';
import {
	countStartupWork,
	createPerfSample,
	recordColdStart,
	recordPerfSample,
	type RenderPerfSample
} from './render-perf';
import {
	samePreviewChanges,
	EMPTY_PREVIEW_CHANGES,
	type ConcessionSelection,
	type ContractRenderSource,
	type RenderSnapshot,
	type RenderFailure,
	type RenderJobMeta
} from './types';

const OBSOLETE = Symbol('obsolete render');

interface RenderCurrentInput {
	source: ContractRenderSource;
	concessions: ConcessionSelection;
	/** Caller-owned preview changes must be immutable for the request's lifetime. */
	previewChanges?: readonly ContractChange[];
	profiler: LayoutProfiler;
	priority?: Priority;
	/** Initial activation can publish exact closed pages; warm updates commit atomically. */
	progressive?: boolean;
}
interface RenderRequest extends RenderCurrentInput {
	previewChanges: readonly ContractChange[];
	generation: number;
	perf?: RenderPerfSample;
	abort: AbortController;
	composition?: CompositionRequest;
	firstPagePaint?: { epoch: string; promise: Promise<void>; acknowledge: () => void };
}

/** Latest-request worker: compose, prepare, profile, paginate, reconcile, commit. */
export class ContractRenderController {
	constructor() {
		countStartupWork('rendererCreated');
	}
	snapshot = $state.raw<RenderSnapshot | null>(null);
	pending = $state.raw<RenderJobMeta | null>(null);
	error = $state.raw<RenderFailure | null>(null);
	#generation = 0;
	#next?: RenderRequest;
	#inflight?: RenderRequest;
	#running = false;
	#abort?: AbortController;
	#geometry?: {
		blocks: readonly PreparedBlock[];
		profiles: LayoutProfiles;
		epoch: string;
		owner: symbol;
		history: PaginationHistory;
	};
	#protectedGeometry?: { profiler: LayoutProfiler; owner: symbol };
	#composition?: ContractCompositionEngine;
	#artifacts?: DocumentArtifacts;
	get artifacts() {
		return this.#artifacts;
	}
	get paginationHistory() {
		return this.#geometry?.history;
	}
	#commitListeners = new Set<() => void>();
	#cancelPaintObservation?: () => void;
	#destroyed = false;
	destroy() {
		this.#destroyed = true;
		this.cancelPending();
		this.#cancelPaintObservation?.();
		this.#commitListeners.clear();
		this.#composition = undefined;
		this.#artifacts?.destroy();
		this.#artifacts = undefined;
		this.#protectedGeometry?.profiler.release(this.#protectedGeometry.owner);
		this.#protectedGeometry = undefined;
		this.snapshot = null;
		this.#geometry = undefined;
	}
	beforeCommit(listener: () => void) {
		this.#commitListeners.add(listener);
		return () => {
			this.#commitListeners.delete(listener);
		};
	}
	isCurrent({
		source,
		concessions,
		profiler,
		previewChanges = EMPTY_PREVIEW_CHANGES
	}: RenderCurrentInput) {
		return (
			profiler.epoch !== undefined &&
			this.snapshot?.layoutEpoch === profiler.epoch &&
			this.snapshot?.source === source &&
			sameSelection(this.snapshot.concessions, concessions) &&
			samePreviewChanges(this.snapshot.previewChanges, previewChanges)
		);
	}
	isPreparingCurrent(input: RenderCurrentInput) {
		const job = this.pending;
		return Boolean(
			job &&
			job.generation === this.#generation &&
			job.layoutEpoch !== undefined &&
			job.layoutEpoch === input.profiler.epoch &&
			job.source === input.source &&
			sameSelection(job.concessions, input.concessions) &&
			samePreviewChanges(job.previewChanges, input.previewChanges ?? EMPTY_PREVIEW_CHANGES)
		);
	}
	/** Only the viewer can establish that this generation's first exact page mounted. */
	acknowledgeFirstPagePaint(generation: number, epoch: string) {
		const request = this.#inflight;
		if (request?.generation !== generation || !this.#isCurrent(request, epoch)) return;
		if (request.firstPagePaint?.epoch === epoch) request.firstPagePaint.acknowledge();
	}
	#waitForFirstPagePaint(request: RenderRequest, epoch: string) {
		const signal = request.abort.signal;
		let acknowledge!: () => void;
		const promise = new Promise<void>((resolve, reject) => {
			const cancel = () => reject(signal.reason);
			acknowledge = () => {
				signal.removeEventListener('abort', cancel);
				resolve();
			};
			if (signal.aborted) cancel();
			else signal.addEventListener('abort', cancel, { once: true });
		});
		request.firstPagePaint = { epoch, promise, acknowledge };
	}
	get retainedPageCount() {
		return new Set([...(this.snapshot?.pages ?? []), ...(this.pending?.pages ?? [])]).size;
	}

	protectGeometry(profiler: LayoutProfiler) {
		const geometry = this.#geometry;
		if (!geometry || geometry.epoch !== profiler.epoch) return;
		if (
			this.#protectedGeometry?.profiler !== profiler ||
			this.#protectedGeometry.owner !== geometry.owner
		)
			this.#protectedGeometry?.profiler.release(this.#protectedGeometry.owner);
		profiler.retain(geometry.blocks, geometry.profiles, geometry.epoch, geometry.owner);
		this.#protectedGeometry = { profiler, owner: geometry.owner };
	}
	request(input: RenderCurrentInput) {
		if (this.#destroyed) return;
		const queued = this.#next ?? this.#inflight;
		if (
			this.pending?.status === 'running' &&
			this.pending.layoutEpoch === input.profiler.epoch &&
			queued &&
			queued.source === input.source &&
			queued.profiler === input.profiler &&
			Boolean(queued.progressive) === Boolean(input.progressive) &&
			sameSelection(queued.concessions, input.concessions) &&
			samePreviewChanges(queued.previewChanges, input.previewChanges ?? EMPTY_PREVIEW_CHANGES)
		)
			return;
		if ((input.priority?.() ?? 'foreground') === 'foreground') input.profiler.beginPreparation();
		this.#abort?.abort(OBSOLETE);
		const abort = (this.#abort = new AbortController());
		const generation = ++this.#generation;
		this.#recordCancelled(this.#next);
		this.#next = {
			...input,
			abort,
			concessions: Object.freeze({ ...input.concessions }),
			previewChanges: input.previewChanges ?? EMPTY_PREVIEW_CHANGES,
			generation,
			perf: createPerfSample(generation, input.source.revision)
		};
		if (this.#next.perf) this.#next.perf.priority = input.priority?.() ?? 'foreground';
		if (input.priority?.() === 'background')
			recordColdStart('background-document-preparation-start');
		this.pending = {
			generation,
			sourceRevision: input.source.revision,
			source: this.#next.source,
			concessions: this.#next.concessions,
			previewChanges: this.#next.previewChanges,
			layoutEpoch: input.profiler.epoch,
			pages: Object.freeze([]),
			progressive: Boolean(input.progressive),
			status: 'running'
		};
		this.error = null;
		void this.#drain();
	}
	cancelPending() {
		this.#abort?.abort(OBSOLETE);
		this.#abort = undefined;
		++this.#generation;
		this.#recordCancelled(this.#next);
		this.#next = undefined;
		this.pending = null;
		this.error = null;
	}
	// Validation failures use the same non-destructive technical-error boundary as rendering.
	fail(error: RenderFailure) {
		this.cancelPending();
		this.error = error;
	}
	#recordCancelled(request?: RenderRequest) {
		if (!request?.perf) return;
		request.perf.cancelled = true;
		request.perf.totalMs = performance.now() - request.perf.requestedAt;
		recordPerfSample(request.perf);
	}
	async #drain() {
		if (this.#running) return;
		this.#running = true;
		try {
			while (this.#next) {
				const request = this.#next;
				this.#inflight = request;
				this.#next = undefined;
				try {
					const result = await this.#render(request);
					if (!this.#isCurrent(request, result.snapshot.layoutEpoch)) throw OBSOLETE;
					for (const listener of this.#commitListeners) listener();
					if (!this.#isCurrent(request, result.snapshot.layoutEpoch)) throw OBSOLETE;
					this.#cancelPaintObservation?.();
					this.#geometry = result.geometry;
					this.#artifacts?.composition.retain(result.resolvedBlocks);
					const assignedAt = request.perf ? performance.now() : 0;
					this.snapshot = result.snapshot;
					this.pending = null;
					if (request.perf?.priority === 'background')
						recordColdStart('background-document-preparation-ready', request.perf.requestedAt);
					if (request.perf) {
						request.perf.snapshotAt = assignedAt;
						request.perf.totalMs = assignedAt - request.perf.requestedAt;
						recordPerfSample(request.perf);
						await tick();
						if (this.#destroyed || this.snapshot?.id !== request.generation) continue;
						request.perf.commitToDomMs = performance.now() - assignedAt;
						request.perf.settledTotalMs = performance.now() - request.perf.requestedAt;
						recordPerfSample(request.perf);
						if ((request.priority?.() ?? 'foreground') === 'foreground')
							this.#observePaint(request);
					}
				} catch (cause) {
					if (
						cause === OBSOLETE ||
						cause instanceof StaleLayoutProfileError ||
						request.generation !== this.#generation
					) {
						if (request.generation === this.#generation) this.cancelPending();
						this.#recordCancelled(request);
						continue;
					}
					if (request.perf) {
						request.perf.failed = true;
						request.perf.totalMs = performance.now() - request.perf.requestedAt;
						recordPerfSample(request.perf);
					}
					this.pending = this.pending?.pages.length ? { ...this.pending, status: 'failed' } : null;
					this.error = { message: 'We couldn’t update the contract.', cause };
					console.error('Contract rendering failed.', cause);
				} finally {
					request.composition?.release();
					request.composition = undefined;
				}
			}
		} finally {
			this.#inflight = undefined;
			this.#running = false;
			if (this.#next) void this.#drain();
		}
	}
	#observePaint(request: RenderRequest) {
		const sample = request.perf;
		if (!sample) return;
		this.#cancelPaintObservation?.();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const frame = requestAnimationFrame(() => {
			timer = setTimeout(() => {
				this.#cancelPaintObservation = undefined;
				// The displayed snapshot remains valid while a warm request is pending.
				if (
					this.#destroyed ||
					request.generation !== this.snapshot?.id ||
					sample.failed ||
					(request.priority?.() ?? 'foreground') !== 'foreground'
				)
					return;
				sample.paintOpportunityAt = performance.now();
				sample.inputToPaintOpportunityMs = sample.paintOpportunityAt - sample.inputAt;
				sample.visibleUpdateMs = sample.paintOpportunityAt - sample.requestedAt;
				recordPerfSample(sample);
			}, 0);
		});
		this.#cancelPaintObservation = () => {
			cancelAnimationFrame(frame);
			clearTimeout(timer);
		};
	}
	#isCurrent(request: RenderRequest, epoch: string) {
		return (
			!this.#destroyed &&
			!request.abort.signal.aborted &&
			request.generation === this.#generation &&
			request.profiler.epoch === epoch
		);
	}
	async #render(request: RenderRequest): Promise<{
		snapshot: RenderSnapshot;
		resolvedBlocks: readonly ResolvedBlock[];
		geometry: {
			blocks: readonly PreparedBlock[];
			profiles: LayoutProfiles;
			epoch: string;
			owner: symbol;
			history: PaginationHistory;
		};
	}> {
		// Leave the effect flush before the profile surface uses flushSync.
		await tick();
		if (request.generation !== this.#generation) throw OBSOLETE;
		const epoch = request.profiler.epoch;
		if (epoch === undefined) throw new StaleLayoutProfileError();
		const checkCurrent = () => {
			if (!this.#isCurrent(request, epoch)) throw OBSOLETE;
		};
		const perf = request.perf;
		if (perf) {
			perf.layoutEpoch = epoch;
			perf.renderStartedAt = performance.now();
		}
		if (this.#artifacts?.source !== request.source) {
			this.#artifacts?.destroy();
			this.#artifacts = new DocumentArtifacts(request.source);
			this.#composition = this.#artifacts.createComposer();
		}
		const artifacts = this.#artifacts;
		const composer = this.#composition!;
		const preparation = artifacts.createPreparation();
		const resolvedBlocks: ResolvedBlock[] = [];
		const prepared: PreparedBlock[] = [];
		const priority = request.priority ?? (() => 'foreground');
		const working = (request.composition = artifacts.composition.createRequest());
		const iterator = composer.iterate(
			{
				items: request.source.items,
				activeConcessions: request.concessions,
				previewChanges: request.previewChanges,
				view: 'redline'
			},
			working
		);
		let preparing: ReturnType<typeof preparation.iterate> | undefined;
		let done = false;
		try {
			while (!done)
				await request.profiler.scheduler.run(
					priority,
					() => {
						checkCurrent();
						const started = performance.now();
						let composeMs = 0,
							prepareMs = 0;
						try {
							do {
								if (preparing) {
									const phaseStart = perf ? performance.now() : 0;
									let next;
									try {
										next = preparing.next();
									} finally {
										if (perf) prepareMs += performance.now() - phaseStart;
									}
									if (next.done) {
										prepared.push(next.value);
										preparing = undefined;
									}
								} else {
									const phaseStart = perf ? performance.now() : 0;
									let next;
									try {
										next = iterator.next();
									} finally {
										if (perf) composeMs += performance.now() - phaseStart;
									}
									if (next.done) {
										done = true;
										break;
									}
									if (next.value) {
										resolvedBlocks.push(next.value);
										preparing = preparation.iterate(next.value);
									}
								}
							} while (performance.now() - started < 4);
						} finally {
							if (perf) {
								perf.composeMs += composeMs;
								perf.prepareMs += prepareMs;
								perf.maxCompositionSliceMs = Math.max(perf.maxCompositionSliceMs, composeMs);
								perf.maxTokenPreparationSliceMs = Math.max(
									perf.maxTokenPreparationSliceMs,
									prepareMs
								);
							}
						}
					},
					request.abort.signal,
					undefined,
					'preparation',
					perf
				);
		} finally {
			iterator.return(undefined);
			preparing?.return(undefined as never);
			if (perf) {
				perf.blocksRecomposed = composer.recomposedBlocks;
				perf.affectedContainers = composer.affectedContainers;
				perf.blocksProcessed = preparation.preparedCount;
				perf.preparedArtifactsReused = preparation.reusedCount;
				perf.containerArtifactsReused = composer.reusedContainers;
				perf.resolvedArtifactsReused = composer.reusedResolvedBlocks;
				perf.tokensProcessed = preparation.tokenCount;
			}
		}
		const addresses = composer.addresses;
		if (perf) {
			perf.compositionCompleteAt = performance.now();
			perf.preparationCompleteAt = performance.now();
		}
		checkCurrent();
		const previousGeometry =
			this.snapshot?.source === request.source && this.#geometry?.epoch === epoch
				? this.#geometry
				: undefined;
		const local = request.profiler.createRequest(
			epoch,
			perf,
			previousGeometry?.profiles,
			checkCurrent
		);
		const profiles = local.profiles;
		const checkpoints = [firstCheckpoint(prepared)];
		const pagination = iterateIncrementalDocument(
			prepared,
			profiles,
			previousGeometry?.history,
			perf
		);
		const pages: import('../pagination/types').PaginatedPage[] = [];
		const changedPages: number[] = [];
		let pagesReused = 0;
		let paginationDone = false;
		let queued: ReturnType<typeof pagination.next> | undefined;
		const advance = () => {
			const started = perf ? performance.now() : 0;
			try {
				return pagination.next();
			} finally {
				if (perf) perf.paginateMs += performance.now() - started;
			}
		};
		let reconciliation: ReturnType<typeof iterateReconciledPages> | undefined;
		const paced = () => Boolean(request.progressive && pages.length && priority() === 'foreground');
		try {
			while (!paginationDone || reconciliation) {
				await request.profiler.scheduler.run(
					priority,
					(deadline) => {
						checkCurrent();
						const started = performance.now();
						const stopAt = Math.min(deadline ?? Infinity, started + 4);
						try {
							do {
								if (reconciliation) {
									const reconcileStart = perf ? performance.now() : 0;
									const next = reconciliation.next();
									if (perf) perf.reconcileMs += performance.now() - reconcileStart;
									if (next.done) {
										pages.push(...next.value.pages);
										changedPages.push(...next.value.changedPages);
										pagesReused += next.value.pagesReused;
										reconciliation = undefined;
										checkCurrent();
										if (request.progressive && this.pending) {
											if (pages.length === 1) this.#waitForFirstPagePaint(request, epoch);
											this.pending = { ...this.pending, pages: Object.freeze([...pages]) };
											if (pages.length === 1 && perf) {
												perf.firstPageAt = performance.now();
												recordPerfSample(perf);
											}
										}
										if (request.firstPagePaint) return;
									}
								} else {
									const next = queued ?? advance();
									queued = undefined;
									if (next.done) {
										paginationDone = true;
										break;
									}
									if (next.value?.type === 'geometry') {
										// One missing block plus its heading's required next-line lookahead.
										const missing = next.value;
										const resolveStarted = perf ? performance.now() : 0;
										queued = local.resolve(missing.block, missing.detail, (upgrade) => {
											let following = advance();
											if (
												following.value?.type === 'geometry' &&
												following.value.block === missing.block &&
												following.value.detail === 'exact'
											) {
												upgrade();
												following = advance();
											}
											return following;
										});

										if (perf) perf.profileResolveMs += performance.now() - resolveStarted;
									} else if (next.value?.type === 'page') {
										checkpoints.push(next.value.next);
										reconciliation = iterateReconciledPages(
											[next.value.page],
											epoch,
											this.snapshot ?? undefined,
											pages.length
										);
									}
								}
							} while (performance.now() < stopAt);
						} finally {
							if (perf) {
								perf.preparationSlices++;
								perf.maxPreparationSliceMs = Math.max(
									perf.maxPreparationSliceMs,
									performance.now() - started
								);
							}
						}
					},
					request.abort.signal,
					paced,
					'preparation',
					perf
				);
				const firstPagePaint = request.firstPagePaint;
				if (firstPagePaint) {
					await firstPagePaint.promise;
					request.firstPagePaint = undefined;
					checkCurrent();
				}
			}
		} finally {
			pagination.return();
			reconciliation?.return({ pages: [], changedPages: [], pagesReused: 0 });
		}
		if (!pages.length) throw new Error('Pagination produced no pages.');
		for (let i = pages.length; i < (this.snapshot?.pages.length ?? 0); i++)
			changedPages.push(i + 1);
		if (perf) perf.paginationCompleteAt = performance.now();
		if (perf) {
			perf.pageCount = pages.length;
			perf.pagesChanged = changedPages.length;
			perf.pagesReused = pagesReused;
		}
		checkCurrent();
		const history = { blocks: prepared, pages, checkpoints };
		const geometry = {
			blocks: prepared,
			profiles: new Map(prepared.map((block) => [block, profiles.get(block)!])),
			epoch,
			owner: Symbol('render-geometry'),
			history
		};
		const snapshot = Object.freeze({
			id: request.generation,
			source: request.source,
			concessions: request.concessions,
			previewChanges: request.previewChanges,
			addresses,
			layoutEpoch: epoch,
			changedPages: Object.freeze(changedPages),
			pages: Object.freeze(pages)
		});
		return { snapshot, geometry, resolvedBlocks };
	}
}
