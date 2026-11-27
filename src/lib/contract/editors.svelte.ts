import { isRepItem, sameSelection, type RepInstructionRecord } from '$lib/playbook/model';
import type { TemplateContent } from '../template/model';
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
	type ContractBuyerLink,
	type LiveContractMetadata,
	type LiveContractState,
	type ReadyContract
} from './saved';
import type { getContractSnapshotCache, SavedOpening } from './snapshot-cache';
import { optimisticRemove, optimisticRename } from './optimistic';

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
	| 'templateHint'
	| 'loadFrozenVersion'
	| 'seedConfirmed'
	| 'updateState'
	| 'confirmMetadata'
	| 'remove'
	| 'peek'
	| 'restore'
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
};

/** One compact live observation shared by Settings and the saved opening. No journal/content. */
class ContractMetadataRead {
	data = $state.raw<Metadata | null>();
	buyerName = $state<string | null>(null);
	requestDelivery = $state.raw<RequestDelivery>(null);
	buyerLink = $state.raw<ContractBuyerLink | null>();
	hasUnreadComment = $state(false);
	latestQuote = $state.raw<LiveMetadata['latestQuote']>(null);
	current = $state(false);
	error = $state<string | null>(null);
	rejected = $state(false);
	private attempt?: ReadAttempt;
	private unsubscribe?: () => void;
	private refreshCurrent?: () => void;
	private listeners = new Set<() => void>();
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
		for (const listener of [...this.listeners]) listener();
	}
	seed(live: LiveMetadata | null) {
		// Optimistic deletion hides rows immediately, but cannot discard an unsaved journal.
		if (live === null && this.owner.isRemoving(this.id)) return;
		const data = live ? persistedMetadata(live) : null;
		if (data && (data.companyId !== this.owner.options.companyId || data._id !== this.id)) {
			this.reject();
			return;
		}
		if (data && this.current && this.data && olderContractState(data, this.data)) return;
		this.data = data;
		this.buyerName = live?.buyerName ?? null;
		this.requestDelivery = live?.requestDelivery ?? null;
		this.buyerLink = live?.buyerLink ?? null;
		this.hasUnreadComment = live?.hasUnreadComment ?? false;
		this.latestQuote = live?.latestQuote ?? null;
		this.current = true;
		this.error = null;
		if (data) this.owner.options.cache.confirmMetadata(data);
		else this.owner.deleted(this.id);
		this.publish();
	}
	start() {
		if (this.attempt || !this.owner.accessAvailable) return;
		const attempt = (this.attempt = new ReadAttempt(15_000));
		this.error = null;
		this.rejected = false;
		const owns = () => this.attempt === attempt && !attempt.signal.aborted;
		attempt.signal.addEventListener(
			'abort',
			() => {
				if (this.attempt !== attempt) return;
				this.unsubscribe?.();
				this.unsubscribe = undefined;
				this.refreshCurrent = undefined;
				this.attempt = undefined;
				this.current = false;
				this.error = 'We couldn’t check this contract. Try again.';
				this.publish();
			},
			{ once: true }
		);
		const accept = (live: LiveMetadata | null) => {
			if (!owns()) return;
			attempt.complete();
			this.seed(live);
		};

		const unsubscribe = this.owner.options.client.onUpdate(
			api.contracts.state,
			{
				id: this.id as Id<'savedContracts'>
			},
			accept,
			() => {
				if (owns()) this.reject();
			}
		);
		if (owns()) {
			this.unsubscribe = unsubscribe;
			this.refreshCurrent = () => {
				try {
					const live = unsubscribe.getCurrentValue();
					if (live === undefined) return;
					if (live === null && this.current && this.data === null) return;
					if (
						live &&
						this.current &&
						this.data &&
						live.metadataRevision <= this.data.metadataRevision
					)
						return;
					accept(live);
				} catch {
					// An optional read failure must not turn a committed rename into an error.
				}
			};
			this.refreshCurrent();
		} else unsubscribe();
	}
	confirmCurrent() {
		this.refreshCurrent?.();
	}
	reject() {
		if (this.rejected) return;
		this.stop();
		this.data = undefined;
		this.buyerName = null;
		this.requestDelivery = null;
		this.buyerLink = undefined;
		this.hasUnreadComment = false;
		this.latestQuote = null;
		this.rejected = true;
		this.error = 'We couldn’t check this contract. Try again.';
		this.owner.options.cache.invalidate(this.id);
		this.publish();
	}
	stop() {
		const attempt = this.attempt;
		this.attempt = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.refreshCurrent = undefined;
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
	readonly journal: DraftJournal;
	metadata = $state.raw<Metadata | null>();
	buyerName = $state<string | null>(null);
	requestDelivery = $state.raw<RequestDelivery>(null);
	buyerLink = $state.raw<ContractBuyerLink | null>();
	hasUnreadComment = $state(false);
	latestQuote = $state.raw<LiveMetadata['latestQuote']>(null);
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
		this.journal =
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
		this.releaseDraftOwner = this.journal.registerOwner({
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
			const hint = this.owner.options.cache.templateHint(this.id);
			const hinted = hint
				? this.owner.options.cache
						.loadFrozenVersion(hint.versionId, hint.companyId, attempt.signal, { opening })
						.then(
							(snapshot) => ({ snapshot }),
							() => undefined
						)
				: undefined;
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
				this.buyerLink = read.buyerLink;
				this.hasUnreadComment = read.hasUnreadComment;
				this.latestQuote = read.latestQuote;
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
			const snapshot =
				(hint?.versionId === initial.templateVersionId ? (await hinted)?.snapshot : undefined) ??
				(await waitForRead(
					this.owner.options.cache.loadFrozenVersion(
						initial.templateVersionId,
						initial.companyId,
						attempt.signal,
						{ opening }
					),
					attempt.signal
				));
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
			this.persistence = this.owner.createPersistence(this, state, this.recovery);
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
		this.recovered = false;
		this.journal.discard();
		this.recovery = null;
		this.persistence?.discard();
		if (this.metadata) this.adoptState(this.metadata);
		this.error = null;
	}
	deleted() {
		if (this.removed) return;
		this.removed = true;
		this.cancelFlush();
		this.recovered = false;
		this.journal.discard();
		this.recovery = null;
		this.metadata = null;
		this.requestDelivery = null;
		this.buyerLink = null;
		this.hasUnreadComment = false;
		this.retireView();
		this.viewError = null;
		this.persistence?.accept(null);
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
	seedAuthoritative(live: LiveMetadata) {
		if (!this.accessAvailable || live.companyId !== this.options.companyId) return;
		let entry = this.metadataReads.get(live._id);
		if (!entry) {
			entry = { read: new ContractMetadataRead(live._id, this), refs: 0 };
			this.metadataReads.set(live._id, entry);
		}
		entry.read.seed(live);
	}
	retainMetadata(id: string) {
		let entry = this.metadataReads.get(id);
		if (!entry) {
			entry = { read: new ContractMetadataRead(id, this), refs: 0 };
			this.metadataReads.set(id, entry);
		}
		this.metadataReads.delete(id);
		this.metadataReads.set(id, entry);
		entry.refs++;
		entry.read.start();
		let released = false;
		return {
			read: entry.read,
			release: () => {
				if (released) return;
				released = true;
				entry.refs--;
				this.trimMetadata();
			}
		};
	}
	private trimMetadata() {
		const unpinned = [...this.metadataReads].filter(([, entry]) => entry.refs === 0);
		for (const [id, entry] of unpinned.slice(0, Math.max(0, unpinned.length - 4))) {
			entry.read.destroy();
			this.metadataReads.delete(id);
		}
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
	createPersistence(
		editor: ContractEditor,
		state: Metadata,
		recovery: DraftRecovery['draft'] | null
	): ContractPersistence {
		const journal = editor.journal;
		const retained = recovery ?? journal.read();
		return new ContractPersistence(
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
			(draft) => journal.write(draft),
			retained
		);
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
			},
			/** Confirmed save state can be newer than the editor's live metadata. */
			get currentState() {
				if (this.needsSave || !editor.currentReady || !editor.persistence) return;
				const { concessions, stateRevision } = editor.persistence.confirmed;
				return {
					concessions,
					stateRevision,
					workBlock: editor.persistence.workBlock,
					buyerLink: editor.buyerLink ?? null
				};
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
		const observed = this.metadataReads.get(id);
		// Deliver authoritative absence to every subscriber before retiring the read.
		queueMicrotask(() => {
			if (observed && this.metadataReads.get(id) === observed) {
				observed.read.destroy();
				this.metadataReads.delete(id);
			}
		});
	}
	isRemoving(id: string) {
		return this.byId.get(id)?.deleting === true;
	}
	async remove(id: Id<'savedContracts'>) {
		const entry = this.reserve(id);
		entry.deleting = true;
		entry.interrupt();
		const generation = this.generation;
		try {
			await this.options.client.mutation(
				api.contracts.remove,
				{
					membershipId: this.options.membershipId,
					id
				},
				{ optimisticUpdate: optimisticRemove }
			);
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
		if (!this.alive || !this.accessAvailable)
			throw new Error('Your connection changed. Try again.');
		const observed = this.metadataReads.get(id)?.read;
		const current = observed?.current ? observed.data : null;
		if (!observed || !current) throw new Error('This contract is unavailable for editing.');
		// Keep the settings observer alive if its route closes before the mutation settles.
		const { release } = this.retainMetadata(id);
		try {
			if (current.title === name.trim()) return;
			await this.options.client.mutation(
				api.contracts.rename,
				{
					membershipId: this.options.membershipId,
					id,
					title: name
				},
				{ optimisticUpdate: optimisticRename }
			);
			if (!this.alive || !this.accessAvailable || generation !== this.generation)
				throw new Error('Your connection changed. Check the name before trying again.');
			// Adopt a committed update already present in the SDK cache.
			observed.confirmCurrent();
		} finally {
			release();
		}
	}
	destroy() {
		this.alive = false;
		this.accessAvailable = false;
		this.unregister?.();
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
