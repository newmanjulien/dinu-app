import { isRepItem, sameSelection, type RepInstructionRecord } from '$lib/playbook/model';
import type { TemplateContent } from '../template/model';
import { queryOnce } from '$lib/query-once';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
import type { SessionEditor } from '$lib/auth/viewer-session.svelte';
import type { ConvexClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { getContext, setContext, untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { DocumentSourceInput } from '$lib/document/runtime/source.svelte';
import { concessionSelectionMap } from './changes';
import { DraftJournal, discoverContractDrafts, type DraftRecovery } from './draft-recovery.svelte';
import { ContractPersistence } from './persistence.svelte';
import {
	saveError,
	olderContractState,
	persistedContractMetadata,
	type LiveContractMetadata,
	type LiveContractState,
	type ReadyContract
} from './saved';
import type { getContractSnapshotCache, SavedOpening } from './snapshot-cache';

type LiveMetadata = LiveContractMetadata;
type Metadata = LiveContractState;
export type RequestDelivery = LiveMetadata['requestDelivery'];

const persistedMetadata = persistedContractMetadata;
const cachedWorkBlock = (value: ReadyContract['contract']): Metadata['workBlock'] =>
	'workBlock' in value &&
	(value.workBlock === 'association-required' || value.workBlock === 'deal-unavailable')
		? value.workBlock
		: null;

type SnapshotCache = Pick<
	ReturnType<typeof getContractSnapshotCache>,
	| 'loadFrozenVersion'
	| 'seedConfirmed'
	| 'updateState'
	| 'confirmMetadata'
	| 'remove'
	| 'peek'
	| 'restore'
	| 'restoreMetadata'
	| 'invalidate'
>;

export type SaveStatus = 'Checking' | 'Saving' | 'Paused' | 'Save failed' | 'Conflict' | 'Saved';
export type SaveNotice = {
	id: string;
	name: string;
	status: SaveStatus;
	message?: string;
};

type Options = {
	userId: string;
	membershipId: Id<'memberships'>;
	companyId: Id<'company'>;
	client: Pick<ConvexClient, 'onUpdate' | 'mutation' | 'query'>;
	cache: SnapshotCache;
	registerEditor: (editor: SessionEditor) => () => void;
	onSaved: (notice: SaveNotice) => void;
	onDeleted: (id: string) => void;
	onRenamed: (id: string, name: string) => void;
};

type EditingSession = {
	persistence: ContractPersistence;
	journal: DraftJournal;
	ownsRecovery: boolean;
};

/** One compact live observation shared by Settings and the saved opening. No journal/content. */
class ContractMetadataRead {
	data = $state.raw<Metadata | null>();
	buyerName = $state<string | null>(null);
	requestDelivery = $state.raw<RequestDelivery>(null);
	current = $state(false);
	error = $state<string | null>(null);
	rejected = $state(false);
	private attempt?: ReadAttempt;
	private unsubscribe?: () => void;
	private listeners = new Set<() => void>();
	private epoch = 0;
	constructor(
		readonly id: string,
		private owner: ContractEditors
	) {
		const cached = owner.options.cache.peek(id)?.contract;
		this.data = cached
			? { ...cached, workBlock: cachedWorkBlock(cached), hubspot: cached.hubspot }
			: undefined;
	}
	listen(listener: () => void) {
		this.listeners.add(listener);
		listener();
		return () => {
			this.listeners.delete(listener);
		};
	}
	private publish() {
		for (const listener of this.listeners) listener();
	}
	start() {
		if (this.attempt || !this.owner.accessAvailable) return;
		const epoch = ++this.epoch;
		const attempt = (this.attempt = new ReadAttempt(15_000));
		this.current = false;
		this.error = null;
		this.rejected = false;
		const owns = () => this.attempt === attempt && !attempt.signal.aborted;
		attempt.signal.addEventListener(
			'abort',
			() => {
				if (this.attempt !== attempt) return;
				this.unsubscribe?.();
				this.unsubscribe = undefined;
				this.attempt = undefined;
				this.current = false;
				this.error = 'We couldn’t check this contract. Try again.';
				this.publish();
			},
			{ once: true }
		);
		const unsubscribe = this.owner.options.client.onUpdate(
			api.contracts.state,
			{
				membershipId: this.owner.options.membershipId,
				id: this.id as Id<'savedContracts'>
			},
			(live) => {
				if (!owns()) return;
				const data = live ? persistedMetadata(live) : null;
				if (data && (data.companyId !== this.owner.options.companyId || data._id !== this.id)) {
					this.reject();
					return;
				}
				if (data && this.current && this.data && olderContractState(data, this.data)) return;
				attempt.complete();
				this.data = data;
				this.buyerName = live?.buyerName ?? null;
				this.requestDelivery = live?.requestDelivery ?? null;
				this.current = true;
				this.error = null;
				if (data) this.owner.options.cache.confirmMetadata(data);
				else this.owner.deleted(this.id);
				this.publish();
			},
			() => {
				if (owns()) this.reject();
			}
		);
		if (owns()) this.unsubscribe = unsubscribe;
		else unsubscribe();
		if (this.data === undefined)
			void this.owner.options.cache
				.restoreMetadata(this.id, attempt.signal)
				.then((data) => {
					if (
						epoch !== this.epoch ||
						!owns() ||
						this.current ||
						this.rejected ||
						!data ||
						data.companyId !== this.owner.options.companyId
					)
						return;
					this.data = { ...data, workBlock: cachedWorkBlock(data), hubspot: data.hubspot };
					this.publish();
				})
				.catch(() => {});
	}
	reject() {
		if (this.rejected) return;
		this.stop();
		this.data = undefined;
		this.buyerName = null;
		this.requestDelivery = null;
		this.rejected = true;
		this.error = 'We couldn’t check this contract. Try again.';
		this.owner.options.cache.invalidate(this.id);
		this.publish();
	}
	stop() {
		this.epoch++;
		const attempt = this.attempt;
		this.attempt = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		attempt?.abort();
		this.current = false;
	}
	retry = () => {
		this.stop();
		this.start();
		this.publish();
	};
	destroy() {
		this.stop();
		this.listeners.clear();
	}
}

/** One contract editor and draft backup survive route changes within this member session. */
export class ContractEditor {
	private initialJournal: DraftJournal;
	private session = $state.raw<EditingSession>();
	get journal() {
		return this.session?.journal ?? this.initialJournal;
	}
	metadata = $state.raw<Metadata | null>();
	buyerName = $state<string | null>(null);
	requestDelivery = $state.raw<RequestDelivery>(null);
	snapshot = $state.raw<TemplateContent>();
	persistence = $state.raw<ContractPersistence>();
	error = $state<string | null>(null);
	viewError = $state<string | null>(null);
	initializing = $state(false);
	deleting = $state(false);
	attachments = $state(0);
	private attached = new Set<symbol>();
	private flushing = $state(0);
	private linkReservations = 0;
	private flushLifetime = new AbortController();
	private recovered = $state(false);
	private work: Promise<boolean> | undefined;
	private attempt: ReadAttempt | undefined;
	private viewAttempt: ReadAttempt | undefined;
	private unsubscribe: (() => void) | undefined;
	private releaseEffects: () => void;
	private releaseDraftOwner: () => void;
	private validated = $state(false);
	private version: string | undefined;
	private alive = true;
	private wasPending = false;
	private recovery: DraftRecovery['draft'] | null;
	private removed = $state(false);
	private readableContract = $state.raw<ReadyContract['contract']>();
	private restoration: Promise<ReadyContract | undefined> | undefined;

	get readable() {
		return this.snapshot && this.readableContract
			? {
					id: this.id,
					status: 'ready' as const,
					snapshot: this.snapshot,
					contract: this.readableContract
				}
			: undefined;
	}
	get currentReady() {
		return this.validated && !this.error && Boolean(this.persistence && this.metadata);
	}
	private acceptReadable(data: ReadyContract) {
		if (data.id !== this.id || data.contract.companyId !== this.owner.options.companyId) return;
		if (this.readableContract && olderContractState(data.contract, this.readableContract)) return;
		this.snapshot = data.snapshot;
		this.readableContract = data.contract;
	}
	private restoreReadable(opening: SavedOpening) {
		const cached = this.owner.options.cache.peek(this.id);
		if (cached) this.acceptReadable(cached);
		if (!this.restoration) {
			const attempt = new ReadAttempt(15_000);
			this.viewAttempt = attempt;
			this.restoration = this.owner.options.cache
				.restore(this.id, attempt.signal, opening)
				.then((data) => {
					if (
						data &&
						this.alive &&
						this.viewAttempt === attempt &&
						!attempt.signal.aborted &&
						!this.removed &&
						this.attachments
					)
						this.acceptReadable(data);
					return data;
				})
				.catch(() => undefined)
				.finally(() => {
					attempt.complete();
				});
		}
		return this.restoration;
	}

	private view!: {
		renderChoices: Record<string, string>;
		items: readonly RepInstructionRecord[];
		input: DocumentSourceInput;
		definitionsReady: boolean;
	};
	private retireView!: () => void;
	get items() {
		return this.view.items;
	}
	get renderChoices() {
		return this.view.renderChoices;
	}
	get documentInput() {
		return this.view.input;
	}
	get definitionsReady() {
		return this.view.definitionsReady;
	}

	constructor(
		readonly id: string,
		private owner: ContractEditors,
		recovery?: DraftRecovery
	) {
		this.initialJournal =
			recovery?.journal ?? new DraftJournal(owner.options.userId, id, owner.options.membershipId);
		this.recovery = recovery?.draft ?? this.journal.read();
		this.recovered = Boolean(this.recovery);
		this.releaseEffects = $effect.root(() => {
			const templateItems = $derived(this.snapshot?.items.filter(isRepItem) ?? []);
			const definitionsReady = $derived(Boolean(this.snapshot));
			const input: DocumentSourceInput = $derived({
				kind: 'records',
				contract: true,
				blocks: { data: this.snapshot?.blocks },
				items: { data: this.snapshot ? templateItems : undefined }
			});
			let choicesForDocument: Record<string, string> = {};
			const renderChoices = $derived.by(() => {
				const persistence = this.persistence;
				const readable = this.readableContract;
				const next =
					persistence && !this.isDeleted
						? persistence.choices
						: readable
							? concessionSelectionMap(readable.concessions)
							: {};
				if (!sameSelection(next, choicesForDocument)) choicesForDocument = next;
				return choicesForDocument;
			});
			this.view = {
				get renderChoices() {
					return renderChoices;
				},
				get items() {
					return templateItems;
				},
				get input() {
					return input;
				},
				get definitionsReady() {
					return definitionsReady;
				}
			};
			this.retireView = () => {
				this.snapshot = undefined;
				this.readableContract = undefined;
				this.restoration = undefined;
				untrack(() => {
					void templateItems;
					void input;
				});
			};
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
		this.releaseDraftOwner = this.initialJournal.registerOwner({
			flush: () => this.savePending(),
			hasLocalIntent: () =>
				!this.alive ||
				!this.owner.accessAvailable ||
				this.deleting ||
				this.isDeleted ||
				this.pending ||
				this.inFlight ||
				Boolean(this.error || this.persistence?.error || this.persistence?.conflict)
		});
	}

	attach() {
		const token = Symbol('contract-view');
		this.attached.add(token);
		this.attachments = this.attached.size;
		const cached = this.owner.options.cache.peek(this.id);
		if (cached) this.acceptReadable(cached);
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
	get heldForLink() {
		return this.linkReservations > 0;
	}
	holdForLink() {
		this.linkReservations++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.linkReservations--;
			this.retain();
		};
	}
	get inFlight() {
		return Boolean(this.persistence?.inFlight);
	}
	get name() {
		return (
			this.metadata?.title ??
			this.persistence?.confirmed.title ??
			this.readableContract?.title ??
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
			message: this.error ?? this.persistence?.error ?? this.persistence?.blockedReason ?? undefined
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
		this.restoration = undefined;
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
		this.restoration = undefined;
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
	private loadView(): Promise<boolean> {
		const metadata = this.metadata!;
		const opening: SavedOpening = { id: this.id };
		this.viewError = null;
		const attempt = new ReadAttempt(15_000);
		this.viewAttempt = attempt;
		this.initializing = true;
		const work = waitForRead(
			this.owner.options.cache.loadFrozenVersion(
				metadata.templateVersionId,
				metadata.companyId,
				attempt.signal,
				{ opening }
			),
			attempt.signal
		)
			.then((snapshot) => {
				if (!this.alive || this.viewAttempt !== attempt || attempt.signal.aborted || !this.metadata)
					return false;
				const canonical = this.owner.options.cache.seedConfirmed({
					id: this.id,
					status: 'ready',
					snapshot,
					contract: this.metadata
				});
				if (canonical) this.acceptReadable(canonical);
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
			const opening: SavedOpening = { id: this.id };
			let first!: (state: Metadata | null) => void;
			let failed!: (error: unknown) => void;
			const firstState = new Promise<Metadata | null>((resolve, reject) => {
				first = resolve;
				failed = reject;
			});
			const lease = this.owner.retainMetadata(this.id);
			const read = lease.read;
			const unsubscribe = read.listen(() => {
				if (!this.current(attempt)) return;
				if (read.error) {
					if (read.rejected) this.retireView();
					failed(new Error(read.error));
					this.fail(read.error);
					return;
				}
				if (!read.current) return;
				this.buyerName = read.buyerName;
				this.requestDelivery = read.requestDelivery;
				const state = read.data ?? null;
				this.metadata = state;
				first(state);
				if (!state) {
					this.deleted();
					return;
				}
				if (this.validated) {
					if (!this.validMetadata(state)) {
						this.fail('This contract’s template changed. Open it again to reload.');
						return;
					}
					try {
						this.adoptState(state);
						this.resume();
					} catch (error) {
						this.fail(
							saveError(
								error,
								'We couldn’t recover this contract. Your changes are still stored in this browser.'
							)
						);
					}
				}
			});
			const release = () => {
				unsubscribe();
				lease.release();
			};
			if (this.current(attempt)) this.unsubscribe = release;
			else release();
			if (this.attachments) this.restoreReadable(opening);
			const initial = await waitForRead(firstState, attempt.signal);
			if (!this.current(attempt)) return false;
			if (!initial) {
				this.deleted();
				return true;
			}
			if (!this.validMetadata(initial))
				throw new Error('This contract is unavailable in your company.');
			const snapshot = await waitForRead(
				this.owner.options.cache.loadFrozenVersion(
					initial.templateVersionId,
					initial.companyId,
					attempt.signal,
					{ opening }
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
			this.acceptReadable({
				id: this.id,
				status: 'ready',
				snapshot,
				contract: latest
			});
			if (!this.current(attempt)) return false;
			this.adoptState(this.metadata ?? latest);
			this.persistence!.freeze(this.owner.frozen);
			this.recovered = false;
			this.validated = true;
			const canonical = this.owner.options.cache.seedConfirmed({
				id: this.id,
				status: 'ready',
				snapshot,
				contract: this.metadata ?? latest
			});
			if (canonical) this.acceptReadable(canonical);
			attempt.complete();
			this.resume();
			this.persistence!.retry();
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

	private adoptState(state: Metadata) {
		if (!this.persistence) {
			this.session = this.owner.createSession(this, state, this.recovery);
			this.persistence = this.session.persistence;
			this.recovery = null;
		}
		this.persistence.freeze(this.owner.frozen);
		this.persistence.acceptLive(state);
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
		if (this.session?.ownsRecovery || this.recovery) this.journal.discard();
		this.recovery = null;
		this.persistence?.discard();
		if (this.metadata) this.adoptState(this.metadata);
		this.error = null;
	}
	deleted() {
		if (this.removed) return;
		this.removed = true;
		this.cancelFlush();
		this.wasPending = false;
		this.recovered = false;
		if (this.recovery) this.journal.write(null);
		this.recovery = null;
		this.metadata = null;
		this.requestDelivery = null;
		this.retireView();
		this.viewError = null;
		this.persistence?.accept(null);
		if (this.session?.ownsRecovery) this.journal.write(null);
		this.owner.deleted(this.id);
		this.error = null;
		this.stopReads();
	}
	private retain() {
		if (!this.alive) return;
		if (this.attached.size) return;
		this.retireView();
		if (this.viewAttempt) {
			const attempt = this.viewAttempt;
			this.viewAttempt = undefined;
			this.work = undefined;
			this.initializing = false;
			attempt.abort();
		}
		if (this.inFlight || this.deleting || this.flushing || this.heldForLink) return;
		if (!this.pending) {
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
		this.releaseDraftOwner();
		this.flushLifetime.abort();
		this.stopReads();
		this.retireView();
		this.releaseEffects();
		this.persistence?.destroy();
	}
}

/** Membership-owned aggregate. Recovery is counted before it is registered with account exit. */
export class ContractEditors {
	private metadataReads = new Map<string, { read: ContractMetadataRead; refs: number }>();
	retainMetadata(id: string) {
		let entry = this.metadataReads.get(id);
		if (!entry) {
			entry = { read: new ContractMetadataRead(id, this), refs: 0 };
			this.metadataReads.set(id, entry);
		}
		entry.refs++;
		entry.read.start();
		let released = false;
		return {
			read: entry.read,
			release: () => {
				if (released) return;
				released = true;
				if (--entry.refs === 0) {
					entry.read.destroy();
					this.metadataReads.delete(id);
				}
			}
		};
	}
	rejectMetadata(id: string) {
		const entry = this.metadataReads.get(id);
		if (entry) entry.read.reject();
		else this.options.cache.invalidate(id);
	}
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
	createSession(
		editor: ContractEditor,
		state: Metadata,
		recovery: DraftRecovery['draft'] | null
	): EditingSession {
		const journal = recovery
			? editor.journal
			: new DraftJournal(this.options.userId, editor.id, this.options.membershipId);
		const retained = recovery ?? journal.read();
		const ownsRecovery = true;
		const persistence = new ContractPersistence(
			editor.id as Id<'savedContracts'>,
			state,
			(request) =>
				this.options.client.mutation(api.contracts.save, {
					membershipId: this.options.membershipId,
					id: request.id as Id<'savedContracts'>,
					operationId: request.operationId,
					expectedStateRevision: request.expectedStateRevision,
					selections: request.selections as Record<Id<'playbookItems'>, string>
				}),
			(draft) => {
				if (ownsRecovery) journal.write(draft);
			},
			retained
		);
		return { journal, persistence, ownsRecovery };
	}
	acquire(id: string) {
		const editor = this.reserve(id);
		const handoff = editor.attachments > 0;
		const release = editor.attach();
		this.queue.delete(editor);
		if (this.accessAvailable && !(handoff && (editor.error || editor.viewError)))
			void editor.initialize();
		return { editor, release };
	}
	/** Inspect local intent without starting template or viewer acquisition. */
	reserveForLink(id: string) {
		const editor = this.reserve(id);
		const owner = this;
		return {
			editor,
			release: editor.holdForLink(),
			get needsSave() {
				return Boolean(
					!owner.alive ||
					!owner.accessAvailable ||
					editor.isDeleted ||
					editor.deleting ||
					editor.pending ||
					editor.inFlight ||
					editor.heldForFlush ||
					editor.error ||
					editor.persistence?.error
				);
			}
		};
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
		this.options.onSaved({ id: editor.id, name: editor.name, status: 'Saved' });
	}
	releaseClean(editor: ContractEditor) {
		if (
			this.byId.get(editor.id) !== editor ||
			editor.attachments ||
			editor.pending ||
			editor.inFlight ||
			editor.heldForFlush ||
			editor.heldForLink ||
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
		for (const { read } of this.metadataReads.values()) read.start();
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
		for (const release of this.renameSubscriptions) release();
		for (const { read } of this.metadataReads.values()) read.stop();
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
		const confirm = (state: LiveMetadata | null) => {
			if (!this.alive || generation !== this.generation) return;
			if (!state) {
				this.deleted(id);
				return;
			}
			this.options.cache.confirmMetadata(persistedMetadata(state));
			this.options.onRenamed(id, state.title);
		};
		const unsubscribe = this.options.client.onUpdate(
			api.contracts.state,
			{ membershipId: this.options.membershipId, id },
			confirm,
			() => {}
		);
		const release = () => {
			if (this.renameSubscriptions.delete(release)) unsubscribe();
		};
		this.renameSubscriptions.add(release);
		const read = new ReadAttempt(15_000);
		try {
			const state = await queryOnce(
				this.options.client,
				api.contracts.state,
				{ membershipId: this.options.membershipId, id },
				read.signal
			);
			if (!state) throw new Error('This contract is unavailable for editing.');
			if (!this.alive || generation !== this.generation)
				throw new Error('Your connection changed. Try again.');
			await this.options.client.mutation(api.contracts.rename, {
				membershipId: this.options.membershipId,
				id,
				title: name
			});
			if (!this.alive || generation !== this.generation)
				throw new Error('Your connection changed. Check the name before trying again.');
			try {
				const current = unsubscribe.getCurrentValue();
				if (current !== undefined) confirm(current);
			} catch {
				// An optional query failure must not turn a committed rename into an error.
			}
		} finally {
			read.complete();
			release();
		}
	}
	destroy() {
		this.alive = false;
		this.accessAvailable = false;
		this.unregister?.();
		for (const release of this.renameSubscriptions) release();
		for (const entry of this.entries) entry.destroy();
		for (const { read } of this.metadataReads.values()) read.destroy();
		this.metadataReads.clear();
		this.byId.clear();
		this.queue.clear();
		this.recovering.clear();
	}
}

const key = Symbol('contract-editors');
export const setContractEditors = (editors: ContractEditors) => setContext(key, editors);
export const getContractEditors = () => getContext<ContractEditors>(key);
