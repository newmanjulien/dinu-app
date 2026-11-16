import {
	approvedDocumentInput,
	previewContractDocument,
	type PreviewBasis,
	type ApprovedContractDocument
} from './document-preview';
import { awaitContractOperation } from './operation-result';
import { isRepItem, sameSelection } from '$lib/playbook/model';
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
import { DraftJournal, discoverContractDrafts, type DraftRecovery } from './draft-recovery.svelte';
import { ContractPersistence } from './persistence.svelte';
import { saveError, olderContractState, type ReadyContract } from './saved';
import type { getContractSnapshotCache, SavedOpening } from './snapshot-cache';
import { createReadQuery } from '$lib/auth/read-query.svelte';
import { resolveTemplateItem } from './items';
import type { DocumentSourceInput } from '$lib/document/runtime/source.svelte';

type LiveMetadata = NonNullable<FunctionReturnType<typeof api.contracts.state>>;
type Metadata = Omit<LiveMetadata, 'buyerName'>;
function persistedMetadata({ buyerName, ...metadata }: LiveMetadata): Metadata {
	return metadata;
}
type SnapshotCache = Pick<
	ReturnType<typeof getContractSnapshotCache>,
	| 'loadFrozenVersion'
	| 'seedConfirmed'
	| 'updateState'
	| 'confirmMetadata'
	| 'remove'
	| 'peekApproved'
	| 'rememberApproved'
	| 'loadApproved'
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
	memoryOnly: boolean;
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

function previewError(cause: unknown) {
	return cause instanceof Error ? cause : new Error('Selected contract wording is unavailable.');
}

/** One compact live observation shared by Settings and the saved opening. No journal/content. */
class ContractMetadataRead {
	data = $state.raw<Metadata | null>();
	buyerName = $state<string | null>(null);
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
			? { ...cached, workBlock: cached.workBlock ?? null, hubspot: cached.hubspot }
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
		// Install live ownership before optional target-key storage. A late disk cannot win.
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
					this.data = { ...data, workBlock: data.workBlock ?? null, hubspot: data.hubspot };
					this.publish();
				})
				.catch(() => {});
	}
	reject() {
		if (this.rejected) return;
		this.stop();
		this.data = undefined;
		this.buyerName = null;
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

/** One contract editor and journal survive route changes within this member session. */
export class ContractEditor {
	private initialJournal: DraftJournal;
	private session = $state.raw<EditingSession>();
	get journal() {
		return this.session?.journal ?? this.initialJournal;
	}
	metadata = $state.raw<Metadata | null>();
	buyerName = $state<string | null>(null);
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
	private recoveryName: string | undefined;
	private recovery: DraftRecovery['draft'] | null;
	private removed = $state(false);
	private definitions!: ReturnType<typeof createReadQuery<typeof api.contractDefinitions.current>>;
	private approved = $state.raw<ApprovedContractDocument>();
	private readableContract = $state.raw<ReadyContract['contract']>();
	private restoration: Promise<ReadyContract | undefined> | undefined;
	get readable() {
		return this.snapshot && this.approved && this.readableContract
			? {
					id: this.id,
					status: 'ready' as const,
					snapshot: this.snapshot,
					approved: this.approved,
					contract: this.readableContract
				}
			: undefined;
	}
	get currentReady() {
		return this.validated && !this.error && Boolean(this.persistence && this.metadata);
	}
	private acceptReadable(data: ReadyContract) {
		if (
			!data.approved ||
			data.id !== this.id ||
			data.contract.companyId !== this.owner.options.companyId ||
			data.approved.documentId !== data.contract.documentId ||
			data.approved.documentRevision !== data.contract.documentRevision
		)
			return;
		if (this.readableContract && olderContractState(data.contract, this.readableContract)) return;
		const live = this.definitions.data;
		const approved =
			live &&
			!this.definitions.isLoading &&
			!this.definitions.error &&
			live.documentId === data.contract.documentId &&
			live.documentRevision === data.contract.documentRevision
				? live
				: data.approved;
		this.snapshot = data.snapshot;
		this.approved = this.owner.options.cache.rememberApproved(this.id, approved) ?? approved;
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
	private previewItemId = $state<Id<'playbookItems'>>();
	private readonly previewBases = new SvelteMap<string, PreviewBasis>();
	private readonly basisFlights = new Map<
		string,
		{ attempt: ReadAttempt; result: Promise<void> }
	>();
	private previewFailure = $state.raw<{ key: string; error: Error }>();
	private view!: {
		renderChoices: Record<string, string>;
		items: ReturnType<typeof resolveTemplateItem>[];
		input: DocumentSourceInput;
		definitionsReady: boolean;
		focusedPreview: ReturnType<typeof previewContractDocument>;
		previewError?: Error;
	};
	private retireView!: () => void;
	get items() {
		return this.view.items;
	}
	/** Main annotations follow applied options only; local intent belongs to the focused panel. */
	get renderChoices() {
		return this.view.renderChoices;
	}
	/** Controls may edit only the exact approved document currently materialized in this view. */
	get currentDocumentReady() {
		return Boolean(
			this.currentReady &&
			!this.definitions.isLoading &&
			!this.definitions.error &&
			this.definitions.data?.displayIdentity === this.approved?.displayIdentity &&
			this.approved &&
			this.persistence &&
			this.approved.documentId === this.persistence.confirmed.documentId &&
			this.approved.documentRevision === this.persistence.confirmed.documentRevision
		);
	}
	get documentInput() {
		return this.view.input;
	}
	get definitionsReady() {
		return this.view.definitionsReady;
	}
	get focusedPreview() {
		return this.view.focusedPreview;
	}
	get previewError() {
		return (
			this.view.previewError ??
			(this.previewFailure && this.previewFailure.key === this.basisKey(this.previewItemId)
				? this.previewFailure.error
				: undefined)
		);
	}
	get previewBusy() {
		const key = this.basisKey(this.previewItemId);
		return Boolean(key && !this.previewBases.has(key) && !this.previewError);
	}
	private basisKey(itemId?: string) {
		if (!itemId || !this.approved || !this.persistence || !this.currentDocumentReady)
			return undefined;
		const head = this.persistence.confirmed.playbook.find((item) => item.itemId === itemId);
		return JSON.stringify([
			this.approved.displayIdentity,
			itemId,
			head?.currentChangeId ?? null,
			head?.appliedChangeId ?? null
		]);
	}
	preparePreview(itemId: string | null) {
		this.previewItemId = itemId ? (itemId as Id<'playbookItems'>) : undefined;
		if (itemId) void this.prefetchPreview(itemId);
	}
	/** Row/panel pointer and focus intent share one small basis flight and a 32-entry LRU. */
	prefetchPreview(itemId: string): Promise<void> {
		const key = this.basisKey(itemId);
		if (!key || !this.attachments || !this.owner.accessAvailable || this.owner.frozen)
			return Promise.resolve();
		const cached = this.previewBases.get(key);
		if (cached) {
			this.previewBases.delete(key);
			this.previewBases.set(key, cached);
			return Promise.resolve();
		}
		const existing = this.basisFlights.get(key);
		if (existing) return existing.result;
		const attempt = new ReadAttempt(15_000);
		const result = queryOnce(
			this.owner.options.client,
			api.contractDefinitions.previewBasis,
			{
				membershipId: this.owner.options.membershipId,
				id: this.id as Id<'savedContracts'>,
				itemId: itemId as Id<'playbookItems'>
			},
			attempt.signal
		)
			.then((basis) => {
				if (
					!this.alive ||
					this.basisFlights.get(key)?.attempt !== attempt ||
					attempt.signal.aborted ||
					this.basisKey(itemId) !== key ||
					basis.displayIdentity !== this.approved?.displayIdentity
				)
					return;
				const actual = JSON.stringify([
					basis.displayIdentity,
					itemId,
					basis.currentChangeId,
					basis.appliedChangeId
				]);
				if (actual !== key) return;
				this.previewBases.set(key, basis);
				while (this.previewBases.size > 32)
					this.previewBases.delete(this.previewBases.keys().next().value!);
				if (this.previewFailure?.key === key) this.previewFailure = undefined;
			})
			.catch((cause) => {
				if (
					this.alive &&
					this.basisFlights.get(key)?.attempt === attempt &&
					this.basisKey(itemId) === key
				)
					this.previewFailure = { key, error: previewError(cause) };
			})
			.finally(() => {
				attempt.complete();
				if (this.basisFlights.get(key)?.attempt === attempt) this.basisFlights.delete(key);
			});
		this.basisFlights.set(key, { attempt, result });
		return result;
	}
	private stopPreviewReads() {
		const flights = [...this.basisFlights.values()];
		this.basisFlights.clear();
		for (const flight of flights) flight.attempt.abort();
	}
	private retirePreviews() {
		this.previewBases.clear();
		this.stopPreviewReads();
		this.previewFailure = undefined;
	}

	constructor(
		readonly id: string,
		private owner: ContractEditors,
		recovery?: DraftRecovery
	) {
		this.initialJournal =
			recovery?.journal ?? new DraftJournal(owner.options.userId, id, owner.options.membershipId);
		this.recovery = recovery?.draft ?? this.journal.read();
		this.recovered = Boolean(this.recovery || this.journal.recoveryError);
		this.recoveryName = this.recovery?.base.title;
		this.releaseEffects = $effect.root(() => {
			// Derivations belong to the editor root, never the route effect that first opens it.
			const templateItems = $derived(
				this.snapshot?.items.filter(isRepItem).map(resolveTemplateItem) ?? []
			);
			const approvedResult = $derived.by(() => {
				if (!this.approved || !this.snapshot) return { value: null };
				try {
					return { value: approvedDocumentInput(this.snapshot, this.approved) };
				} catch (cause) {
					return { value: null, error: previewError(cause) };
				}
			});
			const rendered = $derived(approvedResult.value);
			const definitionsReady = $derived(Boolean(rendered));
			const input: DocumentSourceInput = $derived(
				rendered ?? {
					kind: 'records',
					contract: true,
					materialized: { error: this.definitions.error ?? approvedResult.error },
					items: { error: this.definitions.error ?? approvedResult.error }
				}
			);
			const focusedResult = $derived.by(() => {
				const itemId = this.previewItemId,
					key = this.basisKey(itemId);
				const basis = key ? this.previewBases.get(key) : undefined;
				const item = templateItems.find((item) => item._id === itemId);
				if (!basis || !item || !this.approved) return { value: null };
				try {
					return {
						value: previewContractDocument({
							approved: this.approved,
							item,
							basis,
							action: this.persistence?.intent[item._id]
						})
					};
				} catch (cause) {
					return { value: null, error: previewError(cause) };
				}
			});
			let choicesForDocument: Record<string, string> = {};
			const renderChoices = $derived.by(() => {
				const readable = this.readableContract;
				if (!readable) return choicesForDocument;
				const confirmed = this.persistence?.confirmed;
				const metadata = this.metadata;
				const approved = this.approved;
				const compatible =
					this.validated &&
					!this.isDeleted &&
					metadata &&
					this.validMetadata(metadata) &&
					readable._id === this.id &&
					readable.companyId === this.owner.options.companyId &&
					readable.templateVersionId === metadata.templateVersionId &&
					approved &&
					approved.documentId === readable.documentId &&
					approved.documentRevision === readable.documentRevision &&
					confirmed &&
					!olderContractState(confirmed, readable) &&
					confirmed.documentId === approved.documentId &&
					confirmed.documentRevision === approved.documentRevision;
				const next = Object.fromEntries(
					((compatible ? confirmed.playbook : readable.playbook) ?? [])
						.filter((item) => item.appliedOptionId !== null)
						.map((item) => [item.itemId, item.appliedOptionId!])
				);
				if (!sameSelection(next, choicesForDocument)) choicesForDocument = next;
				return choicesForDocument;
			});
			const thisEditor = this;
			this.view = {
				get renderChoices() {
					return renderChoices;
				},
				get items() {
					return rendered?.items.data ?? templateItems;
				},
				get input() {
					return input;
				},
				get definitionsReady() {
					return definitionsReady;
				},
				get focusedPreview() {
					return focusedResult.value;
				},
				get previewError() {
					return focusedResult.error;
				}
			};
			this.retireView = () => {
				this.snapshot = undefined;
				this.readableContract = undefined;
				this.restoration = undefined;
				this.approved = undefined;
				this.retirePreviews();
				this.previewItemId = undefined;
				untrack(() => {
					void templateItems;
					void approvedResult;
					void rendered;
					void focusedResult;
					void input;
				});
			};
			this.definitions = createReadQuery(
				owner.options.client,
				api.contractDefinitions.current,
				() =>
					this.attachments &&
					owner.accessAvailable &&
					!owner.frozen &&
					!this.isDeleted &&
					!this.deleting
						? { membershipId: owner.options.membershipId, id: id as Id<'savedContracts'> }
						: 'skip'
			);
			$effect(() => {
				const data = this.definitions.data;
				if (this.definitions.rejected)
					untrack(() => {
						this.retireView();
						owner.rejectMetadata(this.id);
					});
				if (
					data &&
					this.attachments &&
					this.metadata &&
					data.documentId === this.metadata.documentId &&
					data.documentRevision === this.metadata.documentRevision
				)
					untrack(() => {
						if (
							this.approved?.documentId !== data.documentId ||
							this.approved?.documentRevision !== data.documentRevision
						)
							this.retirePreviews();
						if (this.approved?.displayIdentity !== data.displayIdentity)
							if (this.snapshot)
								this.acceptReadable({
									id: this.id,
									status: 'ready',
									snapshot: this.snapshot,
									contract: this.metadata!,
									approved: owner.options.cache.rememberApproved(this.id, data) ?? data
								});
							else this.approved = owner.options.cache.rememberApproved(this.id, data) ?? data;
					});
			});
			$effect(() => {
				const itemId = this.previewItemId,
					key = this.basisKey(itemId);
				if (itemId && key && !this.previewBases.has(key))
					untrack(() => {
						void this.prefetchPreview(itemId);
					});
			});

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
		this.stopPreviewReads();
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
		this.definitions.retry();
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
	/** Rendering data can be reacquired without replacing a healthy save subscription. */
	private loadView(): Promise<boolean> {
		const metadata = this.metadata!;
		const opening: SavedOpening = { id: this.id };
		this.viewError = null;
		const attempt = new ReadAttempt(15_000);
		this.viewAttempt = attempt;
		this.initializing = true;
		const work = waitForRead(
			Promise.all([
				this.owner.options.cache.loadFrozenVersion(
					metadata.templateVersionId,
					metadata.companyId,
					attempt.signal,
					{ opening }
				),
				this.owner.options.cache.loadApproved(this.id, metadata.documentId, attempt.signal, {
					opening,
					documentRevision: metadata.documentRevision
				})
			]),
			attempt.signal
		)
			.then(([snapshot, approved]) => {
				if (!this.alive || this.viewAttempt !== attempt || attempt.signal.aborted || !this.metadata)
					return false;
				const canonical = this.owner.options.cache.seedConfirmed({
					id: this.id,
					status: 'ready',
					snapshot,
					approved,
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
			const cachedApproved = this.owner.options.cache.peekApproved(this.id, initial.documentId);
			if (cachedApproved?.documentRevision === initial.documentRevision && !this.approved)
				this.approved = cachedApproved;
			if (
				this.approved?.documentId !== initial.documentId ||
				this.approved?.documentRevision !== initial.documentRevision
			)
				void this.owner.options.cache
					.loadApproved(this.id, initial.documentId, attempt.signal, {
						opening,
						documentRevision: initial.documentRevision
					})
					.then((data) => {
						if (
							this.current(attempt) &&
							this.metadata &&
							data.documentId === this.metadata.documentId &&
							data.documentRevision === this.metadata.documentRevision
						) {
							if (this.snapshot)
								this.acceptReadable({
									id: this.id,
									status: 'ready',
									snapshot: this.snapshot,
									contract: this.metadata,
									approved: data
								});
							else this.approved = this.owner.options.cache.rememberApproved(this.id, data) ?? data;
						}
					})
					.catch(() => {});
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
			if (this.approved)
				this.acceptReadable({
					id: this.id,
					status: 'ready',
					snapshot,
					contract: latest,
					approved: this.approved
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
				contract: this.metadata ?? latest,
				approved: this.approved
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

	recoveryBlocked(journal: DraftJournal) {
		this.initialJournal = journal;
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
		this.definitions.retry();
		this.previewFailure = undefined;
		if (this.previewItemId) void this.prefetchPreview(this.previewItemId);
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

	discard(allStored = false) {
		this.cancelFlush();
		this.wasPending = false;
		this.recovered = false;
		if (this.session?.ownsRecovery || this.recovery || this.journal.recoveryError)
			if (allStored) this.journal.discardAll();
			else this.journal.discard();
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
		this.retireView();
		this.viewError = null;
		this.persistence?.accept(null);
		if (this.session?.ownsRecovery) this.journal.write(null);
		this.owner.deleted(this.id);
		this.error = null;
		this.stopReads();
	}
	/** View data follows demand; submitted writes and flushes retain only the editor. */
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
				for (const entry of [...this.entries]) entry.discard(true);
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
			async (request, signal) => {
				const result = await this.options.client.mutation(api.contracts.saveChanges, {
					...request,
					membershipId: this.options.membershipId
				});
				if (result.status !== 'preparing') return result;
				return awaitContractOperation<import('./saved').ContractSaveResult>(
					this.options.client,
					{
						membershipId: this.options.membershipId,
						id: request.id,
						kind: 'playbook-save',
						operationId: request.operationId,
						inputs: JSON.stringify([
							request.id,
							{ commands: request.commands, operationId: request.operationId }
						])
					},
					signal,
					request.commands.map((command) => command.id)
				);
			},
			(draft) => {
				if (ownsRecovery) journal.write(draft);
			},
			retained
		);
		if (journal.recoveryError) persistence.blockStoredRecovery();
		return { journal, persistence, ownsRecovery };
	}
	acquire(id: string) {
		const editor = this.reserve(id);
		const handoff = editor.attachments > 0;
		const release = editor.attach();
		this.queue.delete(editor);
		// A screen adopting an opening observes its delivered failure until explicit retry.
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
		this.options.onSaved({ id: editor.id, name: editor.name, status: 'Saved', memoryOnly: false });
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
		const confirm = (state: LiveMetadata | null) => {
			if (!this.alive || generation !== this.generation) return;
			if (!state) {
				this.deleted(id);
				return;
			}
			this.options.cache.confirmMetadata(persistedMetadata(state));
			this.options.onRenamed(id, state.title);
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
				// A no-op may resolve before the SDK's deferred cached-result callback.
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
