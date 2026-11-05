import { recordSchedulerWindow, type SchedulerWindowSample } from './render-perf';

export type RenderPriority = 'foreground' | 'background' | 'alternative';
export type Priority = () => RenderPriority;
const rank = { foreground: 0, alternative: 1, background: 2 };
const WINDOW_MS = 8;
export interface SchedulerMetrics {
	schedulerWaitMs: number;
	maxSchedulerWaitMs: number;
}
type Kind = 'preparation' | 'append';
type DispatchMode = 'immediate' | 'paced' | 'idle';
interface Slice {
	order: number;
	queuedAt: number;
	metrics?: SchedulerMetrics;
	priority: Priority;
	paced?: () => boolean;
	kind: Kind;
	work: (deadline?: number) => unknown;
	resolve: (value: unknown) => void;
	reject: (cause: unknown) => void;
	release?: () => void;
}

/** Shared CPU/DOM slices. Priority is read at dispatch, so navigation promotes queued work. */
export class DocumentScheduler {
	#queue: Slice[] = [];
	#nextOrder = 0;
	#scheduled?: { mode: DispatchMode; cancel: () => void };
	#window?: SchedulerWindowSample;
	#destroyed = false;
	#busy = false;
	#listening = false;
	#visibility = () => {
		this.#scheduled?.cancel();
		this.#scheduled = undefined;
		if (!this.#busy) this.#finishWindow();
		this.#schedule();
	};
	run<T>(
		priority: Priority,
		work: (deadline?: number) => T,
		signal?: AbortSignal,
		paced?: () => boolean,
		kind: Kind = 'preparation',
		metrics?: SchedulerMetrics
	): Promise<Awaited<T>> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (this.#destroyed) return Promise.reject(new Error('Document scheduler released.'));
		if (!this.#listening) {
			document.addEventListener('visibilitychange', this.#visibility);
			this.#listening = true;
		}
		return new Promise<Awaited<T>>((resolve, reject) => {
			const slice: Slice = {
				order: this.#nextOrder++,
				queuedAt: metrics ? performance.now() : 0,
				metrics,
				priority,
				paced,
				kind,
				work,
				resolve: resolve as Slice['resolve'],
				reject
			};
			if (signal) {
				const cancel = () => {
					this.#queue = this.#queue.filter((queued) => queued !== slice);
					slice.release?.();
					reject(signal.reason);
					this.#schedule();
				};
				signal.addEventListener('abort', cancel, { once: true });
				slice.release = () => signal.removeEventListener('abort', cancel);
			}
			this.#queue.push(slice);
			// More paced work keeps the pending paint opportunity. Explicit work can interrupt it.
			if (priority() === 'foreground' && !paced?.()) this.wake();
			else if (priority() === 'foreground' && this.#scheduled?.mode === 'idle') this.wake();
			else this.#schedule();
		});
	}
	wake() {
		this.#visibility();
	}
	#sort() {
		this.#queue.sort(
			(a, b) =>
				rank[a.priority()] - rank[b.priority()] ||
				Number(Boolean(a.paced?.())) - Number(Boolean(b.paced?.())) ||
				(a.paced?.() && b.paced?.()
					? Number(a.kind !== 'append') - Number(b.kind !== 'append')
					: 0) ||
				a.order - b.order
		);
	}
	#mode(slice: Slice): DispatchMode {
		return slice.priority() === 'foreground' ? (slice.paced?.() ? 'paced' : 'immediate') : 'idle';
	}
	#finishWindow() {
		if (!this.#window) return;
		recordSchedulerWindow(this.#window);
		this.#window = undefined;
	}
	#schedule() {
		if (this.#busy || this.#destroyed) return;
		if (!this.#queue.length) {
			this.#scheduled?.cancel();
			this.#scheduled = undefined;
			this.#finishWindow();
			return;
		}
		if (this.#scheduled) return;
		this.#sort();
		const mode = this.#mode(this.#queue[0]);
		if (mode === 'idle' && document.hidden) {
			this.#finishWindow();
			return;
		}
		if (this.#window) {
			if (mode === 'paced' && performance.now() < this.#window.at + WINDOW_MS) {
				this.#dispatch(mode);
				return;
			}
			this.#finishWindow();
		}
		const dispatch = () => {
			this.#scheduled = undefined;
			this.#dispatch(mode);
		};
		let cancel: () => void;
		if (mode === 'paced') {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const frame = requestAnimationFrame(() => {
				timer = setTimeout(dispatch, 0);
			});
			cancel = () => {
				cancelAnimationFrame(frame);
				clearTimeout(timer);
			};
		} else if (mode === 'idle' && typeof window.requestIdleCallback === 'function') {
			const id = window.requestIdleCallback((deadline) => {
				if (deadline.timeRemaining() > 0) dispatch();
				else {
					this.#scheduled = undefined;
					this.#schedule();
				}
			});
			cancel = () => window.cancelIdleCallback(id);
		} else {
			const id = setTimeout(dispatch, mode === 'immediate' ? 0 : 50);
			cancel = () => clearTimeout(id);
		}
		this.#scheduled = { mode, cancel };
	}
	#dispatch(mode: DispatchMode) {
		this.#sort();
		const slice = this.#queue[0];
		if (!slice || this.#mode(slice) !== mode || (mode === 'idle' && document.hidden)) {
			this.#schedule();
			return;
		}
		const started = performance.now();
		if (mode === 'paced') {
			this.#window ??= {
				at: started,
				budgetMs: WINDOW_MS,
				durationMs: 0,
				preparationCallbacks: 0,
				appendedPages: 0,
				preparationMs: 0,
				mountMs: 0,
				overruns: 0
			};
			if (started >= this.#window.at + WINDOW_MS) {
				this.#finishWindow();
				this.#schedule();
				return;
			}
		}
		const windowSample = this.#window;
		this.#queue.shift();
		if (slice.metrics) {
			const waited = started - slice.queuedAt;
			slice.metrics.schedulerWaitMs += waited;
			slice.metrics.maxSchedulerWaitMs = Math.max(slice.metrics.maxSchedulerWaitMs, waited);
		}
		slice.release?.();
		this.#busy = true;
		const finish = () => {
			if (windowSample) {
				const ended = performance.now();
				windowSample.durationMs = ended - windowSample.at;
				if (slice.kind === 'append') {
					windowSample.appendedPages++;
					windowSample.mountMs += ended - started;
				} else {
					windowSample.preparationCallbacks++;
					windowSample.preparationMs += ended - started;
				}
				if (ended > windowSample.at + WINDOW_MS) windowSample.overruns++;
			}
			this.#busy = false;
			if (this.#destroyed) this.#finishWindow();
			else this.#schedule();
		};
		try {
			Promise.resolve(slice.work(windowSample ? windowSample.at + WINDOW_MS : undefined))
				.then(slice.resolve, slice.reject)
				.finally(finish);
		} catch (cause) {
			slice.reject(cause);
			finish();
		}
	}
	destroy() {
		this.#destroyed = true;
		this.#scheduled?.cancel();
		this.#scheduled = undefined;
		if (!this.#busy) this.#finishWindow();
		if (this.#listening) document.removeEventListener('visibilitychange', this.#visibility);
		for (const slice of this.#queue) {
			slice.release?.();
			slice.reject(new Error('Document scheduler released.'));
		}
		this.#queue = [];
	}
}

/** Wait outside serialized work so the surface and scheduler remain available. */
export function afterPaint(signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cancel = () => {
			cancelAnimationFrame(frame);
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const frame = requestAnimationFrame(() => {
			timer = setTimeout(() => {
				signal?.removeEventListener('abort', cancel);
				resolve();
			}, 0);
		});
		signal?.addEventListener('abort', cancel, { once: true });
	});
}
