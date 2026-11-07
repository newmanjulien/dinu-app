import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
import type { SessionEditor } from '$lib/auth/viewer-session.svelte';
import type { ConvexClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { getContext, setContext, untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { DraftJournal, discoverContractDrafts, type DraftRecovery } from './draft-recovery.svelte';
import { ContractPersistence } from './persistence.svelte';
import type { TemplateContent } from './saved';
import { saveError } from './saved';
import type { getContractSnapshotCache } from './snapshot-cache';

type Metadata = NonNullable<FunctionReturnType<typeof api.contracts.state>>;
type SnapshotCache = Pick<
	ReturnType<typeof getContractSnapshotCache>,
	'loadVersion' | 'seedConfirmed' | 'updateState' | 'confirmMetadata' | 'remove'
>;
export type SaveStatus = 'Checking' | 'Saving' | 'Paused' | 'Save failed' | 'Conflict' | 'Saved';
export type SaveNotice = {
	id: string;
	name: string;
	status: SaveStatus;
	message?: string;
	memoryOnly: boolean;
};
type Options = {
	userId: string;
	membershipId: Id<'memberships'>;
	companyId: Id<'company'>;
	client: Pick<ConvexClient, 'onUpdate' | 'mutation'>;
	cache: SnapshotCache;
	registerEditor: (editor: SessionEditor) => () => void;
	onSaved: (notice: SaveNotice) => void;
	onDeleted: (id: string) => void;
	onRenamed: (id: string, name: string) => void;
};

/** One editing owner per contract. No viewer, route, or rendering effects live here. */
export class ContractEditor {
	readonly journal: DraftJournal;
	metadata = $state.raw<Metadata | null>();
	snapshot = $state.raw<TemplateContent>();
	persistence = $state.raw<ContractPersistence>();
	error = $state<string | null>(null);
	viewError = $state<string | null>(null);
	initializing = $state(false);
	deleting = $state(false);
	attachments = $state(0);
	private attached = new Set<symbol>();
	private flushing = $state(0);
	private flushLifetime = new AbortController();
	private recovered = $state(false);
	private work: Promise<boolean> | undefined;
	private attempt: ReadAttempt | undefined;
	private viewAttempt: ReadAttempt | undefined;
	private unsubscribe: (() => void) | undefined;
	private releaseEffects: () => void;
	private validated = false;
	private version: string | undefined;
	private alive = true;
	private wasPending = false;
	private recoveryName: string | undefined;
	private recovery: DraftRecovery['draft'] | null;
	private removed = $state(false);

	constructor(
		readonly id: string,
		private owner: ContractEditors,
		recovery?: DraftRecovery
	) {
		this.journal =
			recovery?.journal ?? new DraftJournal(owner.options.userId, id, owner.options.membershipId);
		this.recovery = recovery?.draft ?? this.journal.read();
		this.recovered = Boolean(this.recovery);
		this.recoveryName = this.recovery?.base.buyerCompanyName;
		this.releaseEffects = $effect.root(() => {
			// Cache writes follow confirmed state alone, never view or save housekeeping.
			$effect(() => {
				const persistence = this.persistence;
				if (!persistence || persistence.deleted || this.removed) return;
				const confirmed = persistence.confirmed;
				untrack(() => this.owner.options.cache.updateState(this.id, confirmed));
			});
			$effect(() => {
				if (this.persistence?.deleted) untrack(() => this.deleted());
			});
			$effect(() => {
				const pending = this.pending || this.inFlight;
				const failed = this.error || this.persistence?.error || this.persistence?.conflict;
				const deleted = this.removed;
				untrack(() => {
					if (pending && !deleted) this.wasPending = true;
					else if (this.wasPending && !failed && !deleted) {
						this.wasPending = false;
						this.owner.saved(this);
					}
				});
			});
			$effect(() => {
				void this.attachments;
				void this.initializing;
				void this.flushing;
				void this.error;
				void this.deleting;
				void this.pending;
				void this.inFlight;
				void this.persistence?.conflict;
				void this.persistence?.error;
				untrack(() => this.retain());
			});
		});
	}
	attach() {
		const token = Symbol('contract-view');
		this.attached.add(token);
		this.attachments = this.attached.size;
		return () => {
			if (this.attached.delete(token)) this.attachments = this.attached.size;
		};
	}
	get pending() {
		return !this.isDeleted && (this.recovered || Boolean(this.persistence?.pending));
	}
	get isDeleted() {
		return this.removed || Boolean(this.persistence?.deleted);
	}
	get heldForFlush() {
		return this.flushing > 0;
	}
	get inFlight() {
		return Boolean(this.persistence?.inFlight);
	}
	get name() {
		return (
			this.persistence?.confirmed.buyerCompanyName ??
			this.metadata?.buyerCompanyName ??
			this.recoveryName ??
			'Contract'
		);
	}
	get notice(): SaveNotice | undefined {
		if (this.isDeleted || (!this.pending && !this.inFlight)) return;
		const status: SaveStatus = this.persistence?.conflict
			? 'Conflict'
			: this.error || this.persistence?.error
				? 'Save failed'
				: this.persistence?.blockedReason || !this.owner.accessAvailable || this.deleting
					? 'Paused'
					: this.initializing || !this.persistence || this.persistence.recoveryPending
						? 'Checking'
						: 'Saving';
		return {
			id: this.id,
			name: this.name,
			status,
			message:
				this.error ?? this.persistence?.error ?? this.persistence?.blockedReason ?? undefined,
			memoryOnly: this.journal.memoryOnly && this.pending
		};
	}
	private current(attempt: ReadAttempt) {
		return this.alive && this.attempt === attempt && !attempt.signal.aborted;
	}
	private stopReads() {
		const attempt = this.attempt;
		this.attempt = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		attempt?.abort();
		this.viewAttempt?.abort();
		this.viewAttempt = undefined;
		this.validated = false;
	}
	interrupt() {
		this.cancelFlush();
		this.persistence?.pause();
		this.persistence?.restartTransport();
		this.stopReads();
		this.work = undefined;
		this.initializing = false;
		this.metadata = undefined;
	}
	initialize(): Promise<boolean> {
		if (!this.alive || !this.owner.accessAvailable || this.deleting) return Promise.resolve(false);
		if (this.isDeleted) return Promise.resolve(true);
		if (this.work) return this.work;
		if (this.validated && !this.error) {
			this.resume();
			if (!this.attachments || this.snapshot) return Promise.resolve(true);
			return this.loadView();
		}
		this.stopReads();
		this.persistence?.pause();
		this.initializing = true;
		this.error = null;
		this.viewError = null;
		const attempt = new ReadAttempt(15_000);
		this.attempt = attempt;
		const work = Promise.resolve()
			.then(() => this.load(attempt))
			.finally(() => {
				if (this.work !== work) return;
				this.work = undefined;
				this.initializing = false;
			});
		this.work = work;
		return work;
	}
	/** Rendering data can be reacquired without replacing a healthy save subscription. */
	private loadView(): Promise<boolean> {
		const metadata = this.metadata!;
		this.viewError = null;
		const attempt = new ReadAttempt(15_000);
		this.viewAttempt = attempt;
		this.initializing = true;
		const work = waitForRead(
			this.owner.options.cache.loadVersion(
				metadata.templateVersionId,
				metadata.companyId,
				attempt.signal
			),
			attempt.signal
		)
			.then((snapshot) => {
				if (!this.alive || this.viewAttempt !== attempt || attempt.signal.aborted) return false;
				this.snapshot = snapshot;
				return true;
			})
			.catch((error) => {
				if (this.alive && this.viewAttempt === attempt)
					this.viewError = saveError(
						error,
						'We couldn’t load this contract. Your changes are still available.'
					);
				return false;
			})
			.finally(() => {
				attempt.complete();
				if (this.viewAttempt === attempt) this.viewAttempt = undefined;
				if (this.work !== work) return;
				this.work = undefined;
				this.initializing = false;
			});
		this.work = work;
		return work;
	}
	private async load(attempt: ReadAttempt): Promise<boolean> {
		try {
			let first!: (state: Metadata | null) => void;
			let failed!: (error: unknown) => void;
			const firstState = new Promise<Metadata | null>((resolve, reject) => {
				first = resolve;
				failed = reject;
			});
			const unsubscribe = this.owner.options.client.onUpdate(
				api.contracts.state,
				{
					membershipId: this.owner.options.membershipId,
					id: this.id as Id<'savedContracts'>
				},
				(state) => {
					if (!this.current(attempt)) return;
					this.metadata = state;
					first(state);
					if (!state) {
						this.deleted();
						return;
					}
					if (this.validated) {
						if (state && !this.validMetadata(state)) {
							this.fail('This contract’s template changed. Open it again to reload.');
							return;
						}
						this.persistence?.accept(state);
						this.resume();
					}
				},
				(error) => {
					if (!this.current(attempt)) return;
					failed(error);
					this.fail(
						saveError(error, 'We couldn’t check this contract. Your changes are still available.')
					);
				}
			);
			if (this.current(attempt)) this.unsubscribe = unsubscribe;
			else unsubscribe();
			const initial = await waitForRead(firstState, attempt.signal);
			if (!this.current(attempt)) return false;
			if (!initial) {
				this.deleted();
				return true;
			}
			if (!this.validMetadata(initial))
				throw new Error('This contract is unavailable in your company.');
			const snapshot = await waitForRead(
				this.owner.options.cache.loadVersion(
					initial.templateVersionId,
					initial.companyId,
					attempt.signal
				),
				attempt.signal
			);
			if (!this.current(attempt)) return false;
			const latest = this.metadata;
			if (!latest) {
				this.deleted();
				return true;
			}
			if (!this.validMetadata(latest) || latest.templateVersionId !== initial.templateVersionId)
				throw new Error('This contract’s template changed. Try again.');
			this.version = latest.templateVersionId;
			this.snapshot = snapshot;
			if (!this.persistence) {
				this.persistence = new ContractPersistence(
					this.id as Id<'savedContracts'>,
					latest,
					(request) =>
						this.owner.options.client.mutation(api.contracts.saveChoices, {
							...request,
							membershipId: this.owner.options.membershipId
						}),
					(draft) => this.journal.write(draft),
					this.recovery,
					new Set(
						snapshot.items
							.filter((item) => item.approvalPolicy.kind === 'required')
							.map((item) => item._id)
					)
				);
				this.recovery = null;
			}
			this.persistence.freeze(this.owner.frozen);
			this.persistence.accept(latest);
			this.recovered = false;
			this.validated = true;
			this.owner.options.cache.seedConfirmed({
				id: this.id,
				status: 'ready',
				snapshot,
				contract: latest
			});
			attempt.complete();
			this.resume();
			this.persistence.retry();
			return true;
		} catch (error) {
			if (this.attempt === attempt && this.alive)
				this.fail(
					saveError(error, 'We couldn’t load this contract. Your changes are still available.')
				);
			return false;
		} finally {
			attempt.complete();
		}
	}
	private validMetadata(state: Metadata) {
		return (
			state.companyId === this.owner.options.companyId &&
			state._id === this.id &&
			(!this.version || state.templateVersionId === this.version)
		);
	}
	private fail(message: string) {
		this.cancelFlush();
		this.error = message;
		this.persistence?.pause();
		this.stopReads();
		this.work = undefined;
		this.initializing = false;
	}
	resume() {
		if (
			this.owner.accessAvailable &&
			!this.deleting &&
			this.validated &&
			!this.error &&
			this.metadata
		)
			this.persistence?.resume();
	}
	retry() {
		this.error = null;
		void this.initialize().then((ready) => {
			if (ready && this.alive) this.persistence?.retry();
		});
	}
	async savePending() {
		this.flushing++;
		const signal = this.flushLifetime.signal;
		try {
			if (this.isDeleted) return true;
			if (!this.owner.accessAvailable || this.deleting || this.error) return false;
			if (!this.validated && !(await waitForRead(this.initialize(), signal))) return this.isDeleted;
			if (this.isDeleted) return true;
			if (!this.persistence || !this.validated) return !this.pending;
			this.resume();
			const saved = await waitForRead(this.persistence.savePending(), signal);
			return this.isDeleted || saved;
		} catch {
			return this.isDeleted;
		} finally {
			this.flushing--;
		}
	}
	private cancelFlush() {
		this.flushLifetime.abort();
		this.flushLifetime = new AbortController();
	}

	discard() {
		this.cancelFlush();
		this.wasPending = false;
		this.recovered = false;
		this.recovery = null;
		this.persistence?.discard();
		this.journal.write(null);
		this.error = null;
	}
	deleted() {
		if (this.removed) return;
		this.removed = true;
		this.cancelFlush();
		this.wasPending = false;
		this.recovered = false;
		this.recovery = null;
		this.metadata = null;
		this.snapshot = undefined;
		this.viewError = null;
		this.persistence?.accept(null);
		this.journal.write(null);
		this.owner.deleted(this.id);
		this.error = null;
		this.stopReads();
	}
	/** View data follows demand; submitted writes and flushes retain only the editor. */
	private retain() {
		if (!this.alive) return;
		if (this.attached.size) return;
		this.snapshot = undefined;
		if (this.viewAttempt) {
			const attempt = this.viewAttempt;
			this.viewAttempt = undefined;
			this.work = undefined;
			this.initializing = false;
			attempt.abort();
		}
		if (this.inFlight || this.deleting || this.flushing) return;
		if (!this.pending) {
			// Destroying a clean abandoned editor aborts its initial read as well.
			this.owner.releaseClean(this);
			return;
		}
		if (this.initializing) return;
		if (this.error || this.persistence?.conflict || this.persistence?.error) {
			this.persistence?.pause();
			this.stopReads();
			return;
		}
	}
	destroy() {
		this.alive = false;
		this.flushLifetime.abort();
		this.stopReads();
		this.releaseEffects();
		this.persistence?.destroy();
		this.snapshot = undefined;
	}
}

/** Membership-owned aggregate. Recovery is counted before it is registered with account exit. */
export class ContractEditors {
	private byId = new SvelteMap<string, ContractEditor>();
	entries = $derived([...this.byId.values()]);
	accessAvailable = $state(false);
	frozen = $state(false);
	private queue = new Set<ContractEditor>();
	private recovering = new Set<ContractEditor>();
	private unregister: (() => void) | undefined;
	private alive = true;
	private generation: number | undefined;
	private started = false;
	private available = false;
	private accountReady = false;
	private renameSubscriptions = new Set<() => void>();
	constructor(readonly options: Options) {}
	start() {
		if (this.started || !this.alive) return;
		this.started = true;
		for (const recovery of discoverContractDrafts(this.options.userId, this.options.membershipId))
			this.queue.add(this.reserve(recovery.id, recovery));
		const owner = this;
		this.unregister = this.options.registerEditor({
			get pending() {
				return owner.pending;
			},
			prepareToLeave: () => this.savePending(),
			retry: () => this.retry(),
			suspend: () => {
				this.accountReady = false;
				this.updateReadiness();
			},
			resume: () => {
				this.accountReady = true;
				this.updateReadiness();
			},
			freeze: (frozen) => {
				this.frozen = frozen;
				for (const entry of this.entries) entry.persistence?.freeze(frozen);
			},
			discard: () => {
				for (const entry of [...this.entries]) entry.discard();
			},
			restartTransport: () => {
				this.interrupt();
				this.resume();
			}
		});
		this.pump();
	}
	configure(available: boolean, frozen: boolean, generation: number) {
		const replaced = this.generation !== undefined && this.generation !== generation;
		this.generation = generation;
		this.frozen = frozen;
		this.available = available;
		if (replaced) this.interrupt();
		this.updateReadiness();
		if (replaced && this.accessAvailable) this.resume();
		for (const entry of this.entries) entry.persistence?.freeze(frozen);
	}
	private reserve(id: string, recovery?: DraftRecovery) {
		let entry = this.byId.get(id);
		if (!entry) {
			entry = new ContractEditor(id, this, recovery);
			this.byId.set(id, entry);
		}
		return entry;
	}
	acquire(id: string) {
		const editor = this.reserve(id);
		const release = editor.attach();
		this.queue.delete(editor);
		if (this.accessAvailable) void editor.initialize();
		return { editor, release };
	}
	get pending() {
		return this.entries.some((entry) => !entry.isDeleted && (entry.pending || entry.inFlight));
	}
	notices = $derived.by((): readonly SaveNotice[] => {
		return this.entries.flatMap((entry) => {
			const notice = entry.notice;
			return notice ? [notice] : [];
		});
	});
	saved(editor: ContractEditor) {
		if (!this.alive) return;
		this.options.onSaved({ id: editor.id, name: editor.name, status: 'Saved', memoryOnly: false });
	}
	releaseClean(editor: ContractEditor) {
		if (
			this.byId.get(editor.id) !== editor ||
			editor.attachments ||
			editor.pending ||
			editor.inFlight ||
			editor.heldForFlush ||
			editor.deleting
		)
			return;
		this.byId.delete(editor.id);
		this.queue.delete(editor);
		editor.destroy();
	}
	private pump() {
		if (!this.started || !this.accessAvailable || !this.alive) return;
		for (const entry of this.queue) {
			if (this.recovering.size >= 2) break;
			this.queue.delete(entry);
			this.recovering.add(entry);
			void entry.initialize().finally(() => {
				this.recovering.delete(entry);
				this.pump();
			});
		}
	}
	private resume() {
		if (!this.accessAvailable || !this.alive) return;
		for (const entry of this.entries) {
			if (entry.attachments) void entry.initialize();
			else if (
				entry.pending &&
				!entry.error &&
				!entry.persistence?.error &&
				!entry.persistence?.conflict
			)
				this.queue.add(entry);
			entry.resume();
		}
		this.pump();
	}
	private updateReadiness() {
		if (!this.alive || !this.available || !this.accountReady) {
			if (!this.accessAvailable) return;
			this.accessAvailable = false;
			this.interrupt();
		} else {
			if (this.accessAvailable) return;
			this.accessAvailable = true;
			this.resume();
		}
	}
	private interrupt() {
		for (const unsubscribe of this.renameSubscriptions) unsubscribe();
		this.renameSubscriptions.clear();
		for (const entry of this.entries) entry.interrupt();
	}
	retry(id?: string) {
		for (const entry of this.entries) {
			if (id && entry.id !== id) continue;
			if (entry.attachments) entry.retry();
			else if (entry.pending || entry.error) {
				entry.error = null;
				this.queue.add(entry);
			}
		}
		this.pump();
	}
	async savePending() {
		if (!this.accessAvailable || !this.alive) return !this.pending;
		this.pump();
		while (this.pending) {
			if (!this.accessAvailable || !this.alive) return false;
			const saving = this.entries.filter(
				(entry) => !entry.isDeleted && (entry.pending || entry.inFlight)
			);
			// Queued recovery keeps its bounded initialization concurrency.
			const active = saving.filter((entry) => !this.queue.has(entry));
			if (!active.length) return false;
			const results = await Promise.all(active.map((entry) => entry.savePending()));
			if (!this.alive || results.some((saved, index) => !saved && !active[index].isDeleted))
				return false;
			this.pump();
		}
		return this.alive;
	}
	deleted(id: string) {
		this.options.cache.remove(id);
		this.options.onDeleted(id);
	}
	async remove(id: Id<'savedContracts'>) {
		const entry = this.reserve(id);
		entry.deleting = true;
		entry.interrupt();
		const generation = this.generation;
		try {
			await this.options.client.mutation(api.contracts.remove, {
				membershipId: this.options.membershipId,
				id
			});
			if (!this.alive || generation !== this.generation)
				throw new Error('Your connection changed. Check the contract before trying again.');
			entry.deleted();
		} catch (error) {
			if (this.alive && this.byId.get(id) === entry) {
				entry.deleting = false;
				entry.retry();
			}
			throw error;
		} finally {
			if (this.alive) {
				entry.deleting = false;
				this.releaseClean(entry);
			}
		}
	}
	async rename(id: Id<'savedContracts'>, name: string) {
		const generation = this.generation;
		const confirm = (state: Metadata | null) => {
			if (!this.alive || generation !== this.generation) return;
			if (!state) {
				this.deleted(id);
				return;
			}
			this.options.cache.confirmMetadata(state);
			this.options.onRenamed(id, state.buyerCompanyName);
		};
		// Home may have no editing editor. Subscribe before submitting the command:
		// Convex delivers query transitions before resolving the mutation promise.
		const unsubscribe = this.options.client.onUpdate(
			api.contracts.state,
			{ membershipId: this.options.membershipId, id },
			confirm,
			() => {
				// Cache refresh is optional. The mutation reports command failures,
				// and an editing editor always checks fresh state on opening.
			}
		);
		this.renameSubscriptions.add(unsubscribe);
		try {
			await this.options.client.mutation(api.contracts.rename, {
				membershipId: this.options.membershipId,
				id,
				buyerCompanyName: name
			});
			if (!this.alive || generation !== this.generation)
				throw new Error('Your connection changed. Check the name before trying again.');
			try {
				// A no-op may resolve before the SDK's deferred cached-result callback.
				const current = unsubscribe.getCurrentValue();
				if (current !== undefined) confirm(current);
			} catch {
				// An optional query failure must not turn a committed rename into an error.
			}
		} finally {
			this.renameSubscriptions.delete(unsubscribe);
			unsubscribe();
		}
	}
	destroy() {
		this.alive = false;
		this.accessAvailable = false;
		this.unregister?.();
		for (const unsubscribe of this.renameSubscriptions) unsubscribe();
		this.renameSubscriptions.clear();
		for (const entry of this.entries) entry.destroy();
		this.byId.clear();
		this.queue.clear();
		this.recovering.clear();
	}
}
const key = Symbol('contract-editors');
export const setContractEditors = (editors: ContractEditors) => setContext(key, editors);
export const getContractEditors = () => getContext<ContractEditors>(key);
