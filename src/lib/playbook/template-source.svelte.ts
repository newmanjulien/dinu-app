import { ReadAttempt } from '$lib/auth/attempt';
import { queryOnce } from '$lib/query-once';
import type { SnapshotClient } from '$lib/query-once';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { getContext, setContext } from 'svelte';
import type { StructureSnapshot } from './structure';
import type { TemplateProse, WorkspaceReadStorage } from '$lib/auth/workspace-read-storage';
import { afterStartupPaint } from '$lib/auth/startup-perf';
import { immutable } from '$lib/immutable';

/** A fingerprint selects immutable prose; subscriptions own mutable source identity. */
export class TemplateSource {
	private readers = 0;
	private available = true;
	private generation = 0;
	private accepted = $state.raw<TemplateProse>();
	private envelope =
		$state.raw<
			Pick<
				StructureSnapshot,
				'templateSourceId' | 'templateSourceFingerprint' | 'authoringGeneration'
			>
		>();
	private identity = $state.raw<{ id: Id<'templateSources'>; fingerprint: string } | null>();
	private error = $state.raw<Error>();
	private rejected = $state(false);
	private attempt?: ReadAttempt;
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
	constructor(
		private client: SnapshotClient,
		private membershipId: Id<'memberships'>,
		readonly storage?: WorkspaceReadStorage
	) {
		const owner = this;
		this.read = {
			get data() {
				const fingerprint =
					owner.identity?.fingerprint ?? owner.envelope?.templateSourceFingerprint;
				return owner.available &&
					!owner.rejected &&
					(!fingerprint || owner.accepted?.templateSourceFingerprint === fingerprint)
					? owner.accepted
					: undefined;
			},
			get error() {
				return owner.error;
			},
			get rejected() {
				return owner.rejected;
			},
			retry: () => {
				owner.attempt?.abort();
				owner.attempt = undefined;
				owner.fetch(true);
			}
		};
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
	}
	observeSource(identity: { id: Id<'templateSources'>; fingerprint: string } | null) {
		const previous = this.identity;
		if (
			previous !== undefined &&
			previous?.id === identity?.id &&
			previous?.fingerprint === identity?.fingerprint
		)
			return;
		this.identity = identity;
		if (previous !== undefined) {
			this.attempt?.abort();
			this.attempt = undefined;
		}
		this.fetch();
	}
	observeEnvelope(value: StructureSnapshot) {
		if (
			!value.ready ||
			(this.envelope && value.authoringGeneration < this.envelope.authoringGeneration)
		)
			return;
		this.envelope = {
			templateSourceId: value.templateSourceId,
			templateSourceFingerprint: value.templateSourceFingerprint,
			authoringGeneration: value.authoringGeneration
		};
		if (value.templateSourceId)
			this.observeSource({
				id: value.templateSourceId,
				fingerprint: value.templateSourceFingerprint
			});
	}
	matchesEnvelope(value: StructureSnapshot) {
		return (
			!this.envelope ||
			(this.envelope.templateSourceId === value.templateSourceId &&
				this.envelope.templateSourceFingerprint === value.templateSourceFingerprint)
		);
	}
	private fetch(force = false) {
		if (this.disposed || !this.available || !this.readers || this.attempt) return;
		const fingerprint = this.identity?.fingerprint ?? this.envelope?.templateSourceFingerprint;
		if (
			!force &&
			this.accepted &&
			(!fingerprint || this.accepted.templateSourceFingerprint === fingerprint)
		)
			return;
		if (this.identity === null) {
			this.accepted = { templateSourceFingerprint: '', blocks: [] };
			return;
		}
		const attempt = (this.attempt = new ReadAttempt(15_000));
		this.error = undefined;
		this.rejected = false;
		const owns = () =>
			!this.disposed && this.available && this.attempt === attempt && !attempt.signal.aborted;
		void (async () => {
			try {
				let value =
					!force && fingerprint ? await this.storage?.readTemplateSource(fingerprint) : undefined;
				if (!owns()) return;
				if (!value)
					value = await queryOnce(
						this.client,
						api.templateSources.authoringSource,
						{},
						attempt.signal
					);
				if (!owns()) return;
				const expected = this.identity?.fingerprint ?? this.envelope?.templateSourceFingerprint;
				if (expected && value.templateSourceFingerprint !== expected)
					throw new Error('The template source changed. Try again.');
				this.accepted = immutable(value) as TemplateProse;
				const accepted = this.accepted;
				this.scheduleStorage('source:' + accepted.templateSourceFingerprint, () =>
					this.storage?.writeTemplateSource(accepted, () => !this.disposed && this.available)
				);
			} catch (cause) {
				if (this.attempt === attempt && !this.disposed) {
					this.error =
						cause instanceof Error
							? cause
							: new Error('The template source could not load. Try again.');
					this.rejected = true;
				}
			} finally {
				attempt.complete();
				if (this.attempt === attempt) this.attempt = undefined;
			}
		})();
	}
	configure(available: boolean, generation: number) {
		if (this.disposed) return;
		const changed = generation !== this.generation;
		if (!available || changed) {
			this.attempt?.abort();
			this.attempt = undefined;
		}
		if (!available) this.accepted = undefined;
		this.available = available;
		this.generation = generation;
		if (available) {
			this.fetch(changed);
			this.scheduleWork();
		}
	}
	retain(_hydrate = true) {
		this.readers++;
		this.fetch();
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
		this.accepted = undefined;
		this.cancelPaint?.();
		clearTimeout(this.workTimer);
		this.work.clear();
		this.releaseInput?.();
		this.attempt?.abort();
	}
}
const key = Symbol('template-source');
export const setTemplateSource = (source: TemplateSource) => setContext(key, source);
export const getTemplateSource = () => getContext<TemplateSource>(key);
