import { createOperationId } from '../contract/operation-identity';
import {
	assertOperationRetryable,
	isOperationRecovery,
	operationResultError,
	OperationResultFailure
} from '../contract/operation-recovery';
import { subscribeNativePage } from '../native-pagination';
import { ReplyDiscussion } from './reply-state.svelte';
import { DiscussionReads } from './reads.svelte';
import { ReadAttempt, waitForRead } from '../auth/attempt';
import {
	DiscussionDrafts,
	type DiscussionOperation,
	type ReplyDraft,
	type EditDraft
} from './recovery.svelte';
export type { ReplyDraft, EditDraft } from './recovery.svelte';
import { coordinateDiscussionViewer } from './viewer-bootstrap';
import { DiscussionRetention, LiveDiscussionPages } from './live-pages.svelte';
import type { ConvexClient } from 'convex/browser';
import { ConvexError, type Infer } from 'convex/values';
import { queryOnce } from '../query-once';
import { validDiscussionText } from './limits';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type {
	DiscussionAnchor,
	discussionCommand,
	discussionThread,
	publicAuthor,
	writeResult
} from './validators';
import { saveError } from '../contract/saved';
import { awaitContractOperation } from '../contract/operation-result';
import type { completedWriteResult, discussionOperationResult } from './validators';
import { validate } from 'convex-helpers/validators';
import { completedWriteResult as completedResult } from './validators';
export type DiscussionThread = Infer<typeof discussionThread>;
export type DiscussionAuthor = Infer<typeof publicAuthor>;
export type { DiscussionAccess } from './validators';
import type { DiscussionAccess } from './validators';
class DiscussionRequestError extends Error {
	constructor(
		message: string,
		readonly definitive: boolean,
		readonly status?: number,
		readonly authenticationRequired = false,
		readonly operationCode?: string
	) {
		super(message);
	}
}
export class DiscussionSession {
	readonly reads = new DiscussionReads();
	readonly feed: LiveDiscussionPages<DiscussionThread>;
	private retention = new DiscussionRetention();
	private recent = $state.raw<DiscussionThread[]>([]);
	private created = new Map<Id<'discussionThreads'>, (() => void) | undefined>();
	private recentGeneration = 0;
	readonly threads = $derived.by(() =>
		this.feed.authorized
			? [...new Map([...this.recent, ...this.feed.rows].map((row) => [row.id, row])).values()]
			: []
	);
	private acknowledgeCreated(id: Id<'discussionThreads'>) {
		for (const [operationId, threadId] of this.drafts.created) {
			if (threadId === id) this.drafts.created.delete(operationId);
		}
	}
	reconcileCreateOutcomes() {
		if (!this.alive || !this.active || !this.feed.authorized || !this.feed.firstPageAccepted)
			return;
		const primary = new Set(this.feed.currentRows.map((row) => row.id));
		const pending = new Set(this.drafts.created.values());
		for (const id of pending) {
			if (primary.has(id)) {
				this.acknowledgeCreated(id);
				continue;
			}
			if (this.created.has(id)) continue;
			if (this.created.size >= 20) {
				const oldest = [...this.created.keys()].find(
					(key) => key !== this.selected && !pending.has(key)
				);
				if (!oldest) continue;
				this.created.get(oldest)?.();
				this.created.delete(oldest);
				this.recent = this.recent.filter((row) => row.id !== oldest);
			}
			this.created.set(id, undefined);
		}
		this.reconcileCreated();
	}
	private reconcileCreated() {
		if (!this.feed.authorized) {
			this.activityGeneration++;
			this.recentGeneration++;
			this.reads.configure();
			this.attempt?.abort();
			this.attempt = undefined;
			this.viewerIdentity = undefined;
			this.viewerBootstrapped = false;
			this.closeEditors();
			for (const stop of this.created.values()) stop?.();
			this.created.clear();
			this.recent = [];
			for (const replies of this.replies.values()) replies.destroy();
			return;
		}
		if (!this.active || !this.feed.firstPageAccepted) {
			if (this.recent.length) this.feed.retainDisplay(this.retainedThreads());
			this.recent = [];
			for (const [id, stop] of this.created) {
				stop?.();
				this.created.set(id, undefined);
			}
			for (const replies of this.replies.values()) replies.setActive(false);
			return;
		}
		const primary = new Set(this.feed.currentRows.map((row) => row.id));
		for (const [id, stop] of this.created) {
			if (primary.has(id)) {
				stop?.();
				// Once native coverage owns this row, omissions belong to that coverage too.
				this.created.delete(id);
				this.recent = this.recent.filter((row) => row.id !== id);
				this.acknowledgeCreated(id);
			} else if (!stop) {
				const generation = this.recentGeneration;
				let owned = true;
				let release: (() => void) | undefined;
				const current = () =>
					owned &&
					this.alive &&
					this.active &&
					this.feed.authorized &&
					this.feed.firstPageAccepted &&
					generation === this.recentGeneration &&
					this.created.has(id);
				const stop = () => {
					if (!owned) return;
					owned = false;
					release?.();
					if (this.created.get(id) === stop) this.created.set(id, undefined);
				};
				this.created.set(id, stop);
				try {
					release = this.client.onUpdate(
						api.discussions.thread,
						{ access: this.access, threadId: id },
						(row) => {
							if (!current()) return;
							this.recent = [...this.recent.filter((t) => t.id !== id), ...(row ? [row] : [])];
							this.acknowledgeCreated(id);
							if (!row) {
								stop();
								this.created.delete(id);
							}
						},
						(error) => {
							if (!current()) return;
							stop();
							this.feed.refuse(error);
						}
					);
					if (!owned) release();
				} catch (error) {
					const failed = current();
					stop();
					if (failed)
						this.feed.refuse(
							error instanceof Error ? error : new Error('Comments are unavailable.')
						);
				}
			}
		}
	}
	private retainedThreads() {
		return [...this.threads].sort(
			(a, b) => a.root.createdAt - b.root.createdAt || a.id.localeCompare(b.id)
		);
	}
	private replies = new Map<string, ReplyDiscussion>();
	private replyReferences = new Map<string, number>();
	acquireReplies(id: Id<'discussionThreads'>) {
		const state = this.replyState(id);
		this.replyReferences.set(id, (this.replyReferences.get(id) ?? 0) + 1);
		return {
			state,
			release: () => {
				const remaining = (this.replyReferences.get(id) ?? 1) - 1;
				if (remaining) this.replyReferences.set(id, remaining);
				else {
					this.replyReferences.delete(id);
					state.setActive(false);
				}
				this.trimReplies();
			}
		};
	}
	private trimReplies() {
		const detached = [...this.replies.keys()].filter((id) => !this.replyReferences.has(id));
		for (const id of detached.slice(0, Math.max(0, detached.length - 8))) {
			this.replies.get(id)?.destroy();
			this.replies.delete(id);
		}
	}
	replyState(id: Id<'discussionThreads'>) {
		let state = this.replies.get(id);
		if (!state) {
			state = new ReplyDiscussion(this.client, this.access, id, this.retention);
			this.replies.set(id, state);
		}
		// LRU changes on actual use/release, never on scroll or a derived getter.
		this.replies.delete(id);
		this.replies.set(id, state);
		this.trimReplies();
		return state;
	}

	private viewerIdentity = $state.raw<DiscussionAuthor>();
	private viewerAccount = false;
	get account() {
		return Boolean(this.privateAccess || this.viewerAccount);
	}
	get viewer() {
		const viewer = this.viewerIdentity;
		return viewer?.buyer ? { ...viewer, name: this.buyerName() || 'Buyer' } : viewer;
	}
	get readOnly() {
		return this.policy().readOnly;
	}
	get viewerKey() {
		return this.readOnly ? undefined : this.viewer?.key;
	}
	get visibleComposer() {
		return this.readOnly ? null : this.drafts.composer;
	}
	/** Capture permission before awaiting auth, a cookie lock, or a UI update. */
	captureWriteAccess() {
		const { generation } = this.policy();
		const epoch = this.viewerEpoch;
		const activityGeneration = this.activityGeneration;
		return () =>
			this.alive &&
			this.active &&
			this.feed.authorized &&
			!this.readOnly &&
			activityGeneration === this.activityGeneration &&
			generation === this.policy().generation &&
			epoch === this.viewerEpoch;
	}
	private requireWriteAccess(current: () => boolean) {
		if (!current())
			throw new Error('The discussion view changed. Your draft is still here. Try again.');
	}
	private policyGeneration?: number;
	synchronizePolicy(generation: number) {
		if (generation === this.policyGeneration) return;
		this.policyGeneration = generation;
		// Detach the consumer, never the owner of an already-dispatched cookie request.
		this.attempt?.abort();
		this.attempt = undefined;
		for (const stop of this.receipts.values()) stop();
		this.closeEditors();
		this.selectionVersion++;
		if (this.selectedThread === 'composer') this.selected = null;
		if (!this.readOnly && this.active && !this.viewer) void this.loadBuyerViewer();
	}
	private viewerError = $state<string | null>(null);
	get error() {
		return (!this.readOnly && this.viewerError) || this.feed.error?.message || null;
	}
	get loading() {
		return this.feed.loading;
	}
	get done() {
		return this.feed.done;
	}
	active = $state(false);
	private selectedThread = $state<string | null>(null);
	private selectionVersion = 0;
	replyingTo = $state<string | null>(null);
	editingMessage = $state<string | null>(null);
	closeEditors() {
		this.replyingTo = null;
		this.editingMessage = null;
	}
	get selected() {
		return this.readOnly && this.selectedThread === 'composer' ? null : this.selectedThread;
	}
	set selected(id: string | null) {
		if (this.readOnly && id === 'composer') return;
		if (this.selectedThread !== id) {
			this.closeEditors();
			this.selectionVersion++;
		}
		this.selectedThread = id;
	}
	private sellerIdentity?: string;
	private accountIdentity?: string;
	private viewerEpoch = 0;
	private activityGeneration = 0;
	private sellerAccount = $state(false);
	recognizeSeller(identity: string | undefined, accountIdentity = identity) {
		if (identity === this.sellerIdentity && accountIdentity === this.accountIdentity) return;
		this.sellerIdentity = identity;
		this.accountIdentity = accountIdentity;
		this.viewerEpoch++;
		this.attempt?.abort();
		this.attempt = undefined;
		this.sellerAccount = !!identity;
		this.viewerIdentity = undefined;
		this.anonymous = false;
		this.accountRefresh = !!identity;
		if (this.active) void this.loadBuyerViewer();
	}
	private attempt?: ReadAttempt;
	authRequired = $state(false);
	private anonymous = false;
	private accountRefresh = false;
	private receipts = new Map<DiscussionOperation, () => void>();
	private receiptPromises = new Map<
		DiscussionOperation,
		Promise<Infer<typeof completedWriteResult>>
	>();
	private viewerBootstrapped = false;
	private alive = true;
	private viewerLoad?: { mode: string; promise: Promise<DiscussionAuthor> };
	private requiredAuthor?: string;
	private requiredBuyer = false;
	replyDraft(id: string) {
		const retained = this.drafts.replies.get(id);
		if (retained) return retained;
		const draft = $state<ReplyDraft>({ text: '', busy: false, error: null });
		this.drafts.replies.set(id, draft);
		return draft;
	}
	editDraft(id: string) {
		const retained = this.drafts.edits.get(id);
		if (retained) return retained;
		const draft = $state<EditDraft>({
			text: '',
			busy: false,
			error: null,
			initialized: false,
			expected: 0,
			authorKey: '',
			account: false
		});
		this.drafts.edits.set(id, draft);
		return draft;
	}
	constructor(
		readonly client: ConvexClient,
		readonly access: DiscussionAccess,
		readonly revision: () => number,
		readonly contentIdentity: () => string,
		readonly policy: () => { readOnly: boolean; generation: number } = () => ({
			readOnly: false,
			generation: 0
		}),
		readonly buyerName: () => string | null = () => null,
		readonly drafts = new DiscussionDrafts(),
		readonly privateAccess?: { membershipId: Id<'memberships'>; id: Id<'savedContracts'> }
	) {
		this.feed = new LiveDiscussionPages(
			(receive, fail) =>
				subscribeNativePage(client, api.discussions.threads, { access }, 20, receive, fail),
			() => {
				this.reconcileCreateOutcomes();
				if (!this.feed.authorized || !this.feed.firstPageAccepted) this.reconcileCreated();
				this.reconcileOperations();
				if (
					this.active &&
					!this.readOnly &&
					this.feed.authorized &&
					this.feed.firstPageAccepted &&
					!this.viewerBootstrapped
				) {
					this.viewerBootstrapped = true;
					void this.loadBuyerViewer();
				}
			},
			{ retention: this.retention }
		);
	}
	setActive(active: boolean) {
		if (!this.alive || this.active === active) return;
		this.active = active;
		this.activityGeneration++;
		this.recentGeneration++;
		for (const stop of this.receipts.values()) stop();
		for (const [id, stop] of this.created) {
			stop?.();
			this.created.set(id, undefined);
		}
		if (!active) for (const replies of this.replies.values()) replies.setActive(false);
		this.attempt?.abort();
		this.attempt = undefined;
		if (!active) {
			this.reads.configure();
			this.closeEditors();
			this.selectionVersion++;
			this.viewerBootstrapped = false;
			this.feed.stop(this.retainedThreads());
			this.recent = [];
			return;
		}
		this.feed.reset();
		this.reconcileCreated();
	}
	private async buyerRequest(
		body: unknown,
		signal: AbortSignal,
		account = false,
		forceBuyer = false,
		current: () => boolean,
		canDispatch: () => boolean
	) {
		let unconfirmedDispatch = false;
		let authenticationRequired = false;
		let operationCode: string | undefined;
		try {
			this.requireWriteAccess(canDispatch);
			const anonymous = forceBuyer || (this.anonymous && !account);
			let token: string | undefined;
			const refreshAccount = async () => {
				authenticationRequired = true;
				const { refreshBuyerAccount } = await waitForRead(
					import('../auth/buyer-discussion-auth'),
					signal
				);
				this.requireWriteAccess(canDispatch);
				const refreshed = await refreshBuyerAccount(signal);
				authenticationRequired = false;
				return refreshed;
			};
			if ((this.accountRefresh || account) && !anonymous) token = await refreshAccount();
			const payload = JSON.stringify(body);
			const send = () => {
				signal.throwIfAborted();
				// Check again after auth and for every retry, immediately before dispatch.
				this.requireWriteAccess(canDispatch);
				unconfirmedDispatch = true;
				return fetch('/api/buyer/discussions', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						...(token ? { Authorization: `Bearer ${token}` } : {}),
						...(anonymous ? { 'X-Discussion-Actor': 'buyer' } : {})
					},
					credentials: 'same-origin',
					cache: 'no-store',
					body: payload,
					signal
				});
			};
			let response = await send();
			if (response.status === 401 && !anonymous) {
				unconfirmedDispatch = false;
				this.requireWriteAccess(canDispatch);
				if (current()) this.authRequired = true;
				this.accountRefresh = true;
				token = await refreshAccount();
				response = await send();
			}
			if (response.ok && current()) this.authRequired = false;
			authenticationRequired = response.status === 401 && !anonymous;

			// These are the trusted ingress’s pre-write refusals and transactional Convex errors.
			if ([400, 401, 403, 409].includes(response.status)) unconfirmedDispatch = false;
			const result: unknown = await response.json();
			if (
				result &&
				typeof result === 'object' &&
				'code' in result &&
				typeof result.code === 'string'
			)
				operationCode = result.code;
			if (!response.ok)
				throw Object.assign(
					new Error(
						result &&
							typeof result === 'object' &&
							'message' in result &&
							typeof result.message === 'string'
							? result.message
							: 'We couldn’t save this message. Try again.'
					),
					{ status: response.status }
				);
			return result;
		} catch (error) {
			if (isOperationRecovery(error)) throw error;
			throw new DiscussionRequestError(
				error instanceof Error ? error.message : 'We couldn’t save this message. Try again.',
				!unconfirmedDispatch,
				error instanceof Error && 'status' in error && typeof error.status === 'number'
					? error.status
					: undefined,
				authenticationRequired,
				operationCode
			);
		}
	}
	async loadBuyerViewer(requiredAuthor = this.requiredAuthor) {
		const current = this.captureWriteAccess();
		if (!current()) return;
		const epoch = this.viewerEpoch;
		const account = Boolean(requiredAuthor && !this.requiredBuyer);
		const forceBuyer = Boolean(requiredAuthor && this.requiredBuyer);
		const actor = account
			? `account:${requiredAuthor}`
			: forceBuyer || this.anonymous
				? 'buyer'
				: 'automatic';
		const mode = JSON.stringify([epoch, actor, this.policy().generation]);
		this.attempt?.abort();
		const attempt = (this.attempt = new ReadAttempt(15_000));
		try {
			const access = this.access;
			let promise: Promise<DiscussionAuthor & { account?: boolean }>;
			if (!this.privateAccess) {
				// One real request owns the cookie lock through body settlement. Each consumer
				// can time out or detach without releasing that shared ownership.
				while (this.viewerLoad && this.viewerLoad.mode !== mode) {
					try {
						await waitForRead(this.viewerLoad.promise, attempt.signal);
					} catch (error) {
						if (attempt.signal.aborted) throw error;
					}
				}
				if (attempt.signal.aborted) throw attempt.signal.reason;
				this.requireWriteAccess(current);
				let load = this.viewerLoad;
				if (!load) {
					promise = coordinateDiscussionViewer((signal) =>
						this.buyerRequest(
							{ kind: 'viewer', ...access },
							signal,
							account,
							forceBuyer,
							() => false,
							current
						)
					) as Promise<DiscussionAuthor>;
					load = this.viewerLoad = { mode, promise };
					const owned = load;
					const release = () => {
						if (this.viewerLoad === owned) this.viewerLoad = undefined;
					};
					void promise.then(release, release);
				}
				promise = load.promise;
			} else {
				this.requireWriteAccess(current);
				promise = queryOnce(
					this.client,
					api.discussions.viewer,
					{ ...access, ...this.privateAccess! },
					attempt.signal
				);
			}
			const viewer = await waitForRead(promise, attempt.signal);
			if (this.attempt !== attempt || !current()) return;
			if (requiredAuthor && viewer.key !== requiredAuthor)
				throw new Error('Reconnect as the original author. Your draft is still here.');
			this.viewerAccount = Boolean(this.privateAccess || viewer.account);
			this.viewerIdentity = viewer;
			this.viewerBootstrapped = true;
			this.viewerError = null;
			this.requiredAuthor = undefined;
			this.authRequired = false;
		} catch (error) {
			if (this.attempt !== attempt || !current()) return;
			this.viewerIdentity = undefined;
			this.authRequired =
				account ||
				this.authRequired ||
				(error instanceof DiscussionRequestError && error.authenticationRequired);
			this.viewerError =
				error instanceof Error ? error.message : 'Comments are unavailable. Try again.';
		} finally {
			attempt.complete();
		}
	}
	get canContinueAsBuyer() {
		return (
			!this.privateAccess &&
			!this.readOnly &&
			!this.sellerAccount &&
			this.drafts.operations.size === 0
		);
	}
	async continueAsBuyer() {
		if (!this.canContinueAsBuyer || this.drafts.submitting) return;
		this.anonymous = true;
		this.requiredAuthor = undefined;
		this.viewerIdentity = undefined;
		this.authRequired = false;
		await this.loadBuyerViewer();
	}
	retry() {
		const retryFeed = Boolean(this.feed.error || !this.feed.authorized);
		if (!this.readOnly && this.viewerError) {
			void this.loadBuyerViewer();
		}
		if (retryFeed) this.feed.retry();
		this.reconcileOperations();
	}
	loadMore() {
		if (this.feed.error || !this.feed.authorized) this.retry();
		else this.feed.loadMore();
	}
	begin(anchor: DiscussionAnchor, type: 'comment' | 'proposal') {
		if (this.readOnly || this.drafts.submitting) return;
		if (!this.drafts.composer) {
			this.drafts.composer = {
				anchor,
				type,
				revision: this.revision(),
				contentIdentity: this.contentIdentity()
			};
			this.drafts.text = '';
			this.drafts.composeError = null;
		}
		this.selected = 'composer';
		void this.loadBuyerViewer();
	}
	cancel() {
		if (!this.drafts.submitting) {
			this.drafts.composer = null;
			this.drafts.text = '';
			this.drafts.composeError = null;
			if (this.selected === 'composer') this.selected = null;
		}
	}
	async write(
		command: Infer<typeof discussionCommand>,
		requiredAuthor?: string,
		requiredBuyer = false
	): Promise<Infer<typeof completedWriteResult>> {
		const current = this.captureWriteAccess();
		this.requireWriteAccess(current);
		if (
			command.kind !== 'delete' &&
			!validDiscussionText(
				command.text,
				(command.kind === 'create' && command.type === 'proposal') ||
					(command.kind === 'edit' &&
						this.threads.some((t) => t.type === 'proposal' && t.root.id === command.messageId))
			)
		)
			throw new Error('Enter a message of 20,000 characters or fewer.');
		const retained = this.drafts.operations.get(JSON.stringify(command));
		if (retained) {
			requiredAuthor = retained.authorKey;
			requiredBuyer = !retained.account;
		}
		if (requiredAuthor && this.viewer?.key !== requiredAuthor) {
			this.requiredAuthor = requiredAuthor;
			this.requiredBuyer = requiredBuyer;
			this.authRequired = true;
			await this.loadBuyerViewer(requiredAuthor);
		}
		this.requireWriteAccess(current);
		if (!this.viewer || (!requiredAuthor && this.anonymous && !this.viewer.buyer))
			await this.loadBuyerViewer(requiredAuthor);
		this.requireWriteAccess(current);
		if (requiredAuthor && this.viewer?.key !== requiredAuthor)
			throw new Error('Reconnect as the original author. Your draft is still here.');
		if (!this.viewer)
			throw new Error(this.error ?? 'Reconnect before posting. Your draft is still here.');
		const fingerprint = JSON.stringify(command);
		let operation = this.drafts.operations.get(fingerprint);
		if (!operation) {
			const created = $state<DiscussionOperation>({
				id: createOperationId(),
				authorKey: this.viewer.key,
				buyer: this.viewer.buyer,
				account: this.viewerAccount,
				uncertain: false,
				command: JSON.parse(fingerprint) as Infer<typeof discussionCommand>
			});
			operation = created;
			this.drafts.operations.set(fingerprint, operation);
		}
		if (operation.authorKey !== this.viewer.key) {
			this.requiredAuthor = operation.authorKey;
			this.requiredBuyer = !operation.account;
			this.authRequired = true;
			throw new Error(
				'Reconnect as the original author before retrying this message. Your draft is still here.'
			);
		}
		try {
			assertOperationRetryable(operation.id);
			if (operation.blocked)
				throw operationResultError({ error: '', errorCode: 'OPERATION_EXPIRED' });
			if (this.receiptPromises.has(operation))
				return await waitForRead(this.receiptPromises.get(operation)!, AbortSignal.timeout(15_000));
			const original = {
				token: this.access.token,
				operationId: operation.id,
				command: operation.command
			};
			const result = !this.privateAccess
				? ((await this.buyerRequest(
						{ kind: 'write', expectedAuthorKey: operation.authorKey, ...original },
						AbortSignal.timeout(15_000),
						operation.account,
						!operation.account,
						current,
						() => {
							assertOperationRetryable(operation.id);
							return current();
						}
					)) as Infer<typeof writeResult>)
				: await waitForRead(
						this.client.mutation(api.discussions.write, { ...this.privateAccess, ...original }),
						AbortSignal.timeout(15_000)
					);
			if (result.status === 'preparing') {
				operation.uncertain = true;
				return await waitForRead(
					this.attachOperation(fingerprint, operation),
					AbortSignal.timeout(15_000)
				);
			}
			this.acceptOperation(fingerprint, operation, result);
			return result;
		} catch (error) {
			const owned = this.drafts.operations.get(fingerprint) === operation;
			const definitive =
				(error instanceof DiscussionRequestError && error.definitive) ||
				error instanceof ConvexError;
			if (
				isOperationRecovery(error) ||
				(error instanceof DiscussionRequestError &&
					['OPERATION_EXPIRED', 'OPERATION_INVALID', 'OPERATION_FUTURE'].includes(
						error.operationCode ?? ''
					))
			)
				operation.blocked = true;
			else if (definitive && !operation.uncertain) this.settleOperation(fingerprint, operation);
			else if (owned) {
				operation.uncertain = true;
				this.reconcileOperations();
			}
			if (
				owned &&
				this.alive &&
				((error instanceof DiscussionRequestError && error.authenticationRequired) ||
					(error instanceof Error && 'status' in error && error.status === 401))
			) {
				this.requiredAuthor = operation.authorKey;
				this.requiredBuyer = !operation.account;
				this.viewerIdentity = undefined;
				this.authRequired = true;
			}
			throw error;
		}
	}
	private acceptOperation(
		fingerprint: string,
		operation: DiscussionOperation,
		result: Infer<typeof completedWriteResult>
	) {
		if (this.drafts.operations.get(fingerprint) !== operation) return;
		if (operation.command.kind === 'create') this.drafts.created.set(operation.id, result.threadId);
		this.settleOperation(fingerprint, operation);
		this.reconcileCreateOutcomes();
		if (this.alive && operation.command.kind === 'reply')
			this.replyState(result.threadId).showCreated(result.messageId);
	}
	private settleOperation(fingerprint: string, operation: DiscussionOperation) {
		this.receipts.get(operation)?.();
		if (this.drafts.operations.get(fingerprint) === operation)
			this.drafts.operations.delete(fingerprint);
	}
	private attachOperation(
		fingerprint: string,
		operation: DiscussionOperation
	): Promise<Infer<typeof completedWriteResult>> {
		const existing = this.receiptPromises.get(operation);
		if (existing) return existing;
		const lifetime = new AbortController(),
			current = this.captureWriteAccess();
		const stop = () => {
			lifetime.abort();
			if (this.receipts.get(operation) === stop) this.receipts.delete(operation);
			this.receiptPromises.delete(operation);
		};
		this.receipts.set(operation, stop);
		const original = {
			token: this.access.token,
			operationId: operation.id,
			command: operation.command
		};
		const result = async (): Promise<Infer<typeof completedWriteResult>> => {
			assertOperationRetryable(operation.id);
			if (this.privateAccess) {
				const value = await awaitContractOperation<unknown>(
					this.client,
					{
						...this.privateAccess,
						kind: 'discussion-write',
						operationId: operation.id,
						inputs: JSON.stringify(original)
					},
					lifetime.signal
				);
				if (!validate(completedResult, value))
					throw new Error('This message result is unavailable. Try again.');
				return value;
			}
			while (current() && !lifetime.signal.aborted) {
				assertOperationRetryable(operation.id);
				const value = (await this.buyerRequest(
					{ kind: 'result', expectedAuthorKey: operation.authorKey, ...original },
					AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]),
					operation.account,
					!operation.account,
					current,
					current
				)) as Infer<typeof discussionOperationResult>;
				assertOperationRetryable(operation.id, value?.retryUntil);
				if (value?.status === 'failed') throw operationResultError(value);
				if (value?.status === 'complete') {
					const completed: unknown = JSON.parse(value.result);
					if (!validate(completedResult, completed))
						throw new Error('This message result is unavailable. Try again.');
					return completed;
				}
				await new Promise<void>((resolve, reject) => {
					const aborted = () => {
						clearTimeout(timer);
						reject(lifetime.signal.reason);
					};
					const timer = setTimeout(() => {
						lifetime.signal.removeEventListener('abort', aborted);
						resolve();
					}, 1000);
					lifetime.signal.addEventListener('abort', aborted, { once: true });
					if (lifetime.signal.aborted) aborted();
				});
			}
			throw new Error('The discussion view changed. Your draft is still here.');
		};
		const promise = result()
			.then((value) => {
				if (current() && this.drafts.operations.get(fingerprint) === operation) {
					// A late factual result must not leave a duplicate create/reply/edit draft.
					const command = operation.command;
					if (
						command.kind === 'create' &&
						this.drafts.composer &&
						JSON.stringify({ kind: 'create', ...this.drafts.composer, text: this.drafts.text }) ===
							fingerprint
					) {
						this.drafts.composer = null;
						this.drafts.text = '';
						this.drafts.composeError = null;
						if (this.selected === 'composer') this.selected = value.threadId;
					}
					const draft =
						command.kind === 'reply'
							? this.drafts.replies.get(command.threadId)
							: command.kind === 'edit'
								? this.drafts.edits.get(command.messageId)
								: undefined;
					if (
						draft &&
						command.kind !== 'delete' &&
						command.kind !== 'create' &&
						draft.text === command.text
					) {
						draft.text = '';
						draft.error = null;
					}
					this.acceptOperation(fingerprint, operation, value);
				}
				return value;
			})
			.catch((error) => {
				if (
					isOperationRecovery(error) ||
					(error instanceof DiscussionRequestError &&
						['OPERATION_EXPIRED', 'OPERATION_INVALID', 'OPERATION_FUTURE'].includes(
							error.operationCode ?? ''
						))
				)
					operation.blocked = true;
				else if (error instanceof OperationResultFailure)
					this.settleOperation(fingerprint, operation);
				throw error;
			})
			.finally(stop);
		this.receiptPromises.set(operation, promise);
		return promise;
	}
	reconcileOperations() {
		const pending = new Set(this.drafts.operations.values());
		for (const [operation, stop] of this.receipts)
			if (
				!pending.has(operation) ||
				!this.alive ||
				!this.active ||
				this.readOnly ||
				!this.feed.authorized
			)
				stop();
		if (
			!this.alive ||
			!this.active ||
			this.readOnly ||
			!this.feed.authorized ||
			!this.feed.firstPageAccepted
		)
			return;
		for (const [fingerprint, operation] of this.drafts.operations) {
			if (operation.blocked || !operation.uncertain || this.receipts.has(operation)) continue;
			void this.attachOperation(fingerprint, operation).catch((error) => {
				if (this.alive && this.active && !this.readOnly && !this.receipts.has(operation))
					this.viewerError = saveError(
						error,
						'Couldn’t confirm this message. Try again to check the saved result.'
					);
			});
		}
	}
	async submit() {
		const composer = this.drafts.composer;
		if (
			this.readOnly ||
			!composer ||
			this.drafts.submitting ||
			!validDiscussionText(this.drafts.text, composer.type === 'proposal')
		)
			return;
		const current = this.captureWriteAccess();
		this.drafts.submitting = true;
		this.drafts.composeError = null;
		const selectionVersion = this.selectionVersion;
		try {
			const result = await this.write({ kind: 'create', ...composer, text: this.drafts.text });
			if (this.drafts.composer === composer) {
				this.drafts.composer = null;
				this.drafts.text = '';
				if (this.alive && this.selected === 'composer')
					this.selected =
						current() && this.selectionVersion === selectionVersion ? result.threadId : null;
			}
		} catch (error) {
			if (this.drafts.composer === composer)
				this.drafts.composeError =
					error instanceof Error && error.name !== 'ConvexError'
						? error.message
						: saveError(error, 'We couldn’t post this message. Your draft is still here.');
		} finally {
			this.drafts.submitting = false;
		}
	}
	destroy() {
		this.setActive(false);
		this.alive = false;
		for (const [id, draft] of this.drafts.replies) {
			if (!draft.text && !draft.busy) this.drafts.replies.delete(id);
		}
		for (const [id, draft] of this.drafts.edits) {
			if (!draft.initialized && !draft.busy) this.drafts.edits.delete(id);
		}
		this.feed.destroy();
		for (const state of this.replies.values()) state.destroy();
		this.replies.clear();
		this.replyReferences.clear();
		this.created.clear();
		this.recent = [];
		this.retention.clear();
	}
}
