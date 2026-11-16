import { createReadQuery } from '$lib/auth/read-query.svelte';
import type { SnapshotClient } from '$lib/query-once';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { getContext, setContext, untrack } from 'svelte';
import type { StructureSnapshot } from './structure';
import type { TemplateProse, WorkspaceReadStorage } from '$lib/auth/workspace-read-storage';
import { afterStartupPaint } from '$lib/auth/startup-perf';
import { immutable } from '$lib/immutable';

/** One admitted membership's prose; observations and retained display have separate lifetimes. */
export class TemplateSource {
	private readers = $state(0);
	private available = $state(true);
	private generation = $state(0);
	private accepted = $state.raw<TemplateProse>();
	private envelope =
		$state.raw<
			Pick<
				StructureSnapshot,
				'templateSourceId' | 'templateSourceFingerprint' | 'authoringGeneration'
			>
		>();
	private epoch = 0;
	private observed = false;
	private hydrated = false;
	private disposed = false;
	private presented = false;
	private cooldownUntil = 0;
	private work = new Map<string, () => void>();
	private cancelPaint?: () => void;
	private workTimer?: ReturnType<typeof setTimeout>;
	private releaseInput?: () => void;
	readonly read: {
		readonly data: TemplateProse | undefined;
		readonly error: Error | undefined;
		readonly rejected: boolean;
		retry: () => void;
	};
	private releaseEffects: () => void;
	constructor(
		client: SnapshotClient,
		membershipId: Id<'memberships'>,
		readonly storage?: WorkspaceReadStorage
	) {
		let live!: ReturnType<typeof createReadQuery<typeof api.templateSources.authoringSource>>;
		this.releaseEffects = $effect.root(() => {
			const active = $derived(this.available && this.readers > 0);
			live = createReadQuery(
				client,
				api.templateSources.authoringSource,
				() => (active ? { membershipId } : 'skip'),
				() => this.generation
			);
			$effect(() => {
				const value = live.data,
					rejected = live.rejected;
				untrack(() => {
					if (rejected) {
						this.epoch++;
						this.observed = true;
						this.accepted = undefined;
						this.storage?.clearTemplates();
					} else if (value) {
						this.observed = true;
						this.accept(value);
					}
				});
			});
		});
		if (typeof window !== 'undefined') {
			const input = () => {
				this.cooldownUntil = Date.now() + 250;
			};
			for (const type of ['keydown', 'pointerdown', 'scroll', 'input'])
				window.addEventListener(type, input, { capture: true, passive: true });
			this.releaseInput = () => {
				for (const type of ['keydown', 'pointerdown', 'scroll', 'input'])
					window.removeEventListener(type, input, true);
			};
		}
		const owner = this;
		this.read = {
			get data() {
				return live.rejected ? undefined : owner.accepted;
			},
			get error() {
				return live.error;
			},
			get rejected() {
				return live.rejected;
			},
			retry: () => live.retry()
		};
	}
	private accept(value: TemplateProse) {
		// A fingerprint certifies prose reuse only; it carries no fabricated source ID.
		if (
			!this.accepted ||
			this.accepted.templateSourceFingerprint !== value.templateSourceFingerprint
		)
			this.accepted = immutable(value) as TemplateProse;
	}
	/** A complete live audience observation may revoke the other audience's old source ID. */
	observeEnvelope(value: StructureSnapshot) {
		if (
			!value.ready ||
			(this.envelope && value.authoringGeneration < this.envelope.authoringGeneration)
		)
			return;
		if (
			!this.envelope ||
			this.envelope.templateSourceId !== value.templateSourceId ||
			this.envelope.templateSourceFingerprint !== value.templateSourceFingerprint ||
			this.envelope.authoringGeneration < value.authoringGeneration
		)
			this.envelope = {
				templateSourceId: value.templateSourceId,
				templateSourceFingerprint: value.templateSourceFingerprint,
				authoringGeneration: value.authoringGeneration
			};
	}
	matchesEnvelope(value: StructureSnapshot) {
		return (
			!this.envelope ||
			(this.envelope.templateSourceId === value.templateSourceId &&
				this.envelope.templateSourceFingerprint === value.templateSourceFingerprint)
		);
	}

	acceptStored(value: TemplateProse) {
		if (!this.disposed && this.available && !this.observed && !this.accepted) this.accept(value);
	}
	configure(available: boolean, generation: number) {
		if (this.disposed) return;
		if (!available && this.available) {
			this.epoch++;
			this.hydrated = false;
		}
		this.available = available;
		this.generation = generation;
		if (available) this.scheduleWork();
	}
	retain(hydrate = true) {
		this.readers++;
		if (hydrate && this.available && !this.accepted && !this.hydrated && this.storage) {
			this.hydrated = true;
			const epoch = this.epoch;
			// The live subscription is dispatched first; optional disk never delays it.
			queueMicrotask(() => {
				if (this.disposed || !this.available || epoch !== this.epoch) return;
				void this.storage!.readTemplateSource().then((value) => {
					if (value && epoch === this.epoch) this.acceptStored(value);
				});
			});
		}
		let released = false;
		return () => {
			if (!released) {
				released = true;
				this.readers--;
			}
		};
	}
	markPresented() {
		this.presented = true;
		this.scheduleWork();
	}
	/** One changed record per task, after paint and outside the existing input cooldown. */
	scheduleStorage(key: string, work: () => void) {
		this.work.set(key, work);
		this.scheduleWork();
		return () => {
			if (this.work.get(key) === work) this.work.delete(key);
		};
	}
	private scheduleWork() {
		if (this.disposed || !this.presented || !this.work.size || this.cancelPaint || this.workTimer)
			return;
		this.cancelPaint = afterStartupPaint(() => {
			this.cancelPaint = undefined;
			const next = () => {
				this.workTimer = undefined;
				if (this.disposed || !this.available) return;
				const wait = this.cooldownUntil - Date.now();
				if (wait > 0) {
					this.workTimer = setTimeout(next, wait);
					return;
				}
				const entry = this.work.entries().next().value;
				if (entry) {
					this.work.delete(entry[0]);
					entry[1]();
				}
				if (this.work.size) this.workTimer = setTimeout(next, 0);
			};
			this.workTimer = setTimeout(next, 0);
		});
	}

	destroy() {
		this.disposed = true;
		this.epoch++;
		this.accepted = undefined;
		this.cancelPaint?.();
		clearTimeout(this.workTimer);
		this.work.clear();
		this.releaseInput?.();
		this.releaseEffects();
	}
}
const key = Symbol('template-source');
export const setTemplateSource = (source: TemplateSource) => setContext(key, source);
export const getTemplateSource = () => getContext<TemplateSource>(key);
