import type { ConvexClient } from 'convex/browser';
import { ConvexError, type Infer } from 'convex/values';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { ReadAttempt, waitForRead } from '../auth/attempt';
import { saveError } from '../contract/saved';
import { queryOnce } from '../query-once';
import { validDiscussionText } from './limits';
import { DiscussionReads } from './reads.svelte';
import { DiscussionReadState } from './read-state.svelte';
import type {
	DiscussionAccess,
	DiscussionAnchor,
	DiscussionCommand,
	DiscussionMessage,
	DiscussionThread,
	DiscussionWriteResult,
	PublicAuthor
} from './validators';
import { coordinateDiscussionViewer } from './viewer-bootstrap';

export type { DiscussionAccess, DiscussionMessage, DiscussionThread } from './validators';
export type DiscussionAuthor = PublicAuthor;

export type CreateComposerState = {
	kind: 'create';
	anchor: DiscussionAnchor;
	contentRevision: number;
	operationId: string;
	text: string;
	busy: boolean;
	awaitingConfirmation: boolean;
	error: string | null;
};

export type ReplyComposerState = {
	kind: 'reply';
	threadId: Id<'discussionThreads'>;
	operationId: string;
	text: string;
	busy: boolean;
	awaitingConfirmation: boolean;
	error: string | null;
};

export type EditComposerState = {
	kind: 'edit';
	messageId: Id<'discussionMessages'>;
	threadId: Id<'discussionThreads'>;
	authorKey: string;
	account: boolean;
	expected: number;
	operationId: string;
	text: string;
	busy: boolean;
	awaitingConfirmation: boolean;
	error: string | null;
};

export type ActiveComposer = CreateComposerState | ReplyComposerState | EditComposerState;

export type DeleteMessageResult =
	| { status: 'ignored' }
	| { status: 'deleted' }
	| { status: 'error'; message: string; definite: boolean };

class DiscussionRequestError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly authenticationRequired = false
	) {
		super(message);
	}
}

function isDefiniteDiscussionError(error: unknown) {
	if (error instanceof ConvexError) return true;
	if (error instanceof DiscussionRequestError && error.status !== undefined) {
		return (
			error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
		);
	}
	return false;
}

const UNCERTAIN_WRITE_MESSAGE =
	'Couldn’t confirm this message. Retry to check whether it was saved before editing.';

export class DiscussionSession {
	readonly reads = new DiscussionReads();
	activeComposer = $state<ActiveComposer | null>(null);
	deletingMessageId = $state<Id<'discussionMessages'> | null>(null);

	readonly feed: DiscussionReadState;
	private stopAccess: () => void;
	private actorClient: ConvexClient;
	private actorPrivateAccess?: { membershipId: Id<'memberships'>; id: Id<'savedContracts'> };
	private actorKey = 'buyer';
	private actorCurrent: () => boolean = () => true;
	private actorGeneration = $state(0);
	private actorDrafts = new Map<string, { composer: ActiveComposer; selected: string | null }>();

	private viewerIdentity = $state.raw<DiscussionAuthor>();
	private viewerAccount = false;
	private viewerError = $state<string | null>(null);
	private viewerBootstrapped = false;
	private viewerLoad?: { mode: string; promise: Promise<DiscussionAuthor & { account?: boolean }> };
	private attempt?: ReadAttempt;
	private accountPreparation?: { attempt: ReadAttempt; promise: Promise<void> };
	private accountPreparedUntil = 0;
	private accountPreparationRetryAt = 0;

	active = $state(false);
	authRequired = $state(false);
	private selectedThread = $state<string | null>(null);
	private activityGeneration = 0;
	private anonymous = false;
	private accountRefresh = false;
	private requiredAuthor?: string;
	private requiredBuyer = false;
	private alive = true;

	constructor(
		readClient: ConvexClient,
		readonly access: DiscussionAccess,
		readonly contentRevision: () => number,
		readonly policy: () => { readOnly: boolean; generation?: number } = () => ({ readOnly: false }),
		readonly buyerName: () => string | null = () => null,
		privateAccess?: { membershipId: Id<'memberships'>; id: Id<'savedContracts'> },
		readonly perspective: () => 'buyer' | 'seller' = () => 'buyer',
		readonly missingSellerName: () => boolean = () => false
	) {
		this.actorClient = readClient;
		this.actorPrivateAccess = privateAccess;
		this.feed = new DiscussionReadState(readClient, access);
		this.stopAccess = this.feed.onAccess(
			() => this.bootstrapViewer(),
			() => this.resetAfterDeauthorize()
		);
	}

	get client() {
		return this.actorClient;
	}
	get privateAccess() {
		return this.actorPrivateAccess;
	}
	get transitionVersion() {
		return this.actorGeneration;
	}

	private bootstrapViewer() {
		if (this.active && !this.readOnly && !this.viewerBootstrapped) {
			this.viewerBootstrapped = true;
			void this.loadBuyerViewer();
		}
	}

	transitionActor(
		key: string,
		client: ConvexClient,
		privateAccess?: { membershipId: Id<'memberships'>; id: Id<'savedContracts'> },
		current: () => boolean = () => true
	) {
		this.actorCurrent = current;
		if (
			this.actorKey === key &&
			this.actorClient === client &&
			this.actorPrivateAccess?.membershipId === privateAccess?.membershipId &&
			this.actorPrivateAccess?.id === privateAccess?.id
		)
			return;
		if (this.activeComposer) {
			this.actorDrafts.set(this.actorKey, {
				composer: {
					...$state.snapshot(this.activeComposer),
					busy: false,
					awaitingConfirmation:
						this.activeComposer.busy || this.activeComposer.awaitingConfirmation,
					error: this.activeComposer.busy ? UNCERTAIN_WRITE_MESSAGE : this.activeComposer.error
				},
				selected: this.selectedThread
			});
		}
		const visibleThread = this.selectedThread === 'composer' ? null : this.selectedThread;
		this.actorGeneration++;
		this.activityGeneration++;
		this.cancelAccountPreparation();
		this.attempt?.abort();
		this.attempt = undefined;
		this.reads.configure();
		this.actorKey = key;
		this.actorClient = client;
		this.actorPrivateAccess = privateAccess;
		this.viewerIdentity = undefined;
		this.viewerAccount = false;
		this.viewerError = null;
		this.viewerBootstrapped = false;
		this.authRequired = false;
		this.anonymous = false;
		this.accountRefresh = false;
		this.requiredAuthor = undefined;
		this.requiredBuyer = false;
		this.deletingMessageId = null;
		const draft = this.actorDrafts.get(key);
		this.actorDrafts.delete(key);
		this.activeComposer = draft?.composer ?? null;
		this.selectedThread =
			draft?.selected === 'composer' ? 'composer' : (visibleThread ?? draft?.selected ?? null);
		this.bootstrapViewer();
	}

	get threads() {
		return this.feed.threads;
	}
	get authorized() {
		return this.feed.authorized;
	}
	get loading() {
		return this.feed.loading;
	}
	get account() {
		return Boolean(this.privateAccess || this.viewerAccount);
	}
	get viewer() {
		const viewer = this.viewerIdentity;
		return viewer?.buyer ? { ...viewer, name: this.buyerName() || 'Buyer' } : viewer;
	}
	get readOnly() {
		return this.policy().readOnly || !this.actorCurrent();
	}
	get viewerKey() {
		return this.readOnly ? undefined : this.viewer?.key;
	}
	get composer(): CreateComposerState | null {
		return !this.readOnly && this.authorized && this.activeComposer?.kind === 'create'
			? this.activeComposer
			: null;
	}
	get replyingTo(): Id<'discussionThreads'> | null {
		return !this.readOnly && this.activeComposer?.kind === 'reply'
			? this.activeComposer.threadId
			: null;
	}
	get editingMessage(): Id<'discussionMessages'> | null {
		return !this.readOnly && this.activeComposer?.kind === 'edit'
			? this.activeComposer.messageId
			: null;
	}
	get showReconnectCard() {
		return (
			this.authorized &&
			!this.readOnly &&
			this.authRequired &&
			!this.threads.length &&
			!this.composer
		);
	}
	get hasVisibleRail() {
		return Boolean(
			this.feed.pendingFirstPage || this.threads.length || this.composer || this.showReconnectCard
		);
	}
	get error() {
		return (!this.readOnly && this.viewerError) || this.feed.error || null;
	}
	get selected() {
		return this.readOnly && this.selectedThread === 'composer' ? null : this.selectedThread;
	}
	set selected(id: string | null) {
		if (this.readOnly && id === 'composer') return;
		if (
			this.selectedThread !== id &&
			!this.activeComposer?.busy &&
			!this.activeComposer?.awaitingConfirmation
		) {
			if (this.activeComposer?.kind === 'create' && id !== 'composer') this.activeComposer = null;
			else if (this.activeComposer?.kind === 'reply' && this.activeComposer.threadId !== id)
				this.activeComposer = null;
			else if (this.activeComposer?.kind === 'edit' && this.activeComposer.threadId !== id)
				this.activeComposer = null;
		}
		this.selectedThread = id;
	}

	replyComposer(id: Id<'discussionThreads'>): ReplyComposerState | undefined {
		return this.activeComposer?.kind === 'reply' && this.activeComposer.threadId === id
			? this.activeComposer
			: undefined;
	}

	editComposer(id: Id<'discussionMessages'>): EditComposerState | undefined {
		return this.activeComposer?.kind === 'edit' && this.activeComposer.messageId === id
			? this.activeComposer
			: undefined;
	}

	isDeleting(id: Id<'discussionMessages'>) {
		return this.deletingMessageId === id;
	}

	acquireReplies(id: Id<'discussionThreads'>) {
		return this.feed.acquireReplies(id);
	}

	setActive(active: boolean) {
		if (!this.alive || this.active === active) return;
		this.active = active;
		this.activityGeneration++;
		if (!active) {
			this.cancelAccountPreparation();
			this.feed.setActive(false);
			this.attempt?.abort();
			this.attempt = undefined;
			this.reads.configure();
			this.activeComposer = null;
			this.deletingMessageId = null;
			this.selectedThread = null;
			this.viewerBootstrapped = false;
			return;
		}
		this.feed.setActive(true);
		if (this.authorized) this.bootstrapViewer();
	}

	private resetAfterDeauthorize() {
		this.activityGeneration++;
		this.cancelAccountPreparation();
		this.reads.configure();
		this.attempt?.abort();
		this.attempt = undefined;
		this.viewerIdentity = undefined;
		this.viewerAccount = false;
		this.viewerError = null;
		this.viewerBootstrapped = false;
		this.authRequired = false;
		this.anonymous = false;
		this.accountRefresh = false;
		this.requiredAuthor = undefined;
		this.requiredBuyer = false;
		this.activeComposer = null;
		this.actorDrafts.clear();
		this.selectedThread = null;
		this.deletingMessageId = null;
	}

	retry() {
		if (!this.active) return;
		if (!this.readOnly && this.viewerError) void this.loadBuyerViewer();
		this.feed.retry();
	}

	captureWriteAccess() {
		const activityGeneration = this.activityGeneration;
		const actorGeneration = this.actorGeneration;
		const actorKey = this.actorKey;
		const actorClient = this.actorClient;
		const policyGeneration = this.policy().generation;
		return () =>
			this.alive &&
			this.active &&
			this.authorized &&
			!this.readOnly &&
			this.actorCurrent() &&
			actorKey === this.actorKey &&
			actorClient === this.actorClient &&
			activityGeneration === this.activityGeneration &&
			actorGeneration === this.actorGeneration &&
			policyGeneration === this.policy().generation;
	}

	private requireWriteAccess(current: () => boolean) {
		if (!current()) throw new Error('The discussion view changed. Reopen it and try again.');
	}

	closeEditors() {
		if (
			this.activeComposer &&
			this.activeComposer.kind !== 'create' &&
			!this.activeComposer.busy &&
			!this.activeComposer.awaitingConfirmation
		)
			this.activeComposer = null;
	}

	collapseReply(threadId: Id<'discussionThreads'>) {
		if (
			this.activeComposer?.kind === 'reply' &&
			this.activeComposer.threadId === threadId &&
			!this.activeComposer.busy &&
			!this.activeComposer.awaitingConfirmation
		)
			this.activeComposer = null;
	}

	collapseEdit(messageId: Id<'discussionMessages'>) {
		if (
			this.activeComposer?.kind === 'edit' &&
			this.activeComposer.messageId === messageId &&
			!this.activeComposer.busy &&
			!this.activeComposer.awaitingConfirmation
		)
			this.activeComposer = null;
	}

	collapseCreate() {
		if (
			this.activeComposer?.kind === 'create' &&
			!this.activeComposer.busy &&
			!this.activeComposer.awaitingConfirmation
		) {
			this.activeComposer = null;
			if (this.selectedThread === 'composer') this.selectedThread = null;
		}
	}

	openReply(threadId: Id<'discussionThreads'>) {
		if (this.readOnly || this.activeComposer?.busy || this.activeComposer?.awaitingConfirmation)
			return;
		this.selectedThread = threadId;
		if (this.activeComposer?.kind === 'reply' && this.activeComposer.threadId === threadId) return;
		this.activeComposer = {
			kind: 'reply',
			threadId,
			operationId: crypto.randomUUID(),
			text: '',
			busy: false,
			awaitingConfirmation: false,
			error: null
		};
		if (!this.viewerIdentity) void this.loadBuyerViewer();
	}

	openEdit(message: DiscussionMessage, threadId: Id<'discussionThreads'>) {
		if (this.readOnly || this.activeComposer?.busy || this.activeComposer?.awaitingConfirmation)
			return;
		this.selectedThread = threadId;
		if (this.activeComposer?.kind === 'edit' && this.activeComposer.messageId === message.id)
			return;
		this.activeComposer = {
			kind: 'edit',
			messageId: message.id,
			threadId,
			authorKey: message.author.key,
			account: this.account,
			expected: message.revision,
			operationId: crypto.randomUUID(),
			text: message.text,
			busy: false,
			awaitingConfirmation: false,
			error: null
		};
	}

	begin(anchor: DiscussionAnchor) {
		if (this.readOnly || this.activeComposer?.busy || this.activeComposer?.awaitingConfirmation)
			return;
		if (this.activeComposer?.kind === 'create') {
			const sameTarget =
				this.activeComposer.contentRevision === this.contentRevision() &&
				JSON.stringify(this.activeComposer.anchor) === JSON.stringify(anchor);
			if (sameTarget) {
				this.selectedThread = 'composer';
				if (!this.viewerIdentity) void this.loadBuyerViewer();
				return;
			}
		}
		this.activeComposer = {
			kind: 'create',
			anchor,
			contentRevision: this.contentRevision(),
			operationId: crypto.randomUUID(),
			text: '',
			busy: false,
			awaitingConfirmation: false,
			error: null
		};
		this.selectedThread = 'composer';
		if (!this.viewerIdentity) void this.loadBuyerViewer();
	}

	updateComposerText(text: string) {
		const composer = this.activeComposer;
		if (this.readOnly || !composer || composer.busy || composer.awaitingConfirmation) return;
		if (composer.text !== text) {
			composer.text = text;
			composer.operationId = crypto.randomUUID();
		}
		composer.error = null;
		if (composer.kind !== 'edit' && text.trim()) this.preparePostAccount();
	}

	private preparePostAccount() {
		if (
			this.accountPreparation ||
			this.accountPreparedUntil > Date.now() + 10_000 ||
			this.accountPreparationRetryAt > Date.now() ||
			this.privateAccess ||
			!this.viewerAccount ||
			!this.viewer ||
			!this.active ||
			this.readOnly
		)
			return;
		const attempt = new ReadAttempt(15_000);
		const current = this.captureWriteAccess();
		const preparation = {
			attempt,
			promise: import('../auth/buyer-discussion-auth')
				.then(({ prepareBuyerAccount }) =>
					current() ? prepareBuyerAccount(attempt.signal) : undefined
				)
				.then((expiresAt) => {
					if (current()) this.accountPreparedUntil = expiresAt ?? 0;
				})
				.catch(() => {
					if (current()) this.accountPreparationRetryAt = Date.now() + 5_000;
				})
				.finally(() => {
					attempt.complete();
					if (this.accountPreparation === preparation) this.accountPreparation = undefined;
				})
		};
		this.accountPreparation = preparation;
	}

	private cancelAccountPreparation() {
		this.accountPreparation?.attempt.abort();
		this.accountPreparation = undefined;
		this.accountPreparedUntil = 0;
		this.accountPreparationRetryAt = 0;
	}

	private async buyerRequest(
		body: unknown,
		signal: AbortSignal,
		account = false,
		forceBuyer = false,
		current: () => boolean,
		canDispatch: () => boolean
	) {
		let authenticationRequired = false;
		try {
			this.requireWriteAccess(canDispatch);
			const anonymous = forceBuyer || (this.anonymous && !account);
			let token: string | undefined;
			const refreshAccount = async (forceRefresh = false) => {
				authenticationRequired = true;
				const { refreshBuyerAccount } = await waitForRead(
					import('../auth/buyer-discussion-auth'),
					signal
				);
				this.requireWriteAccess(canDispatch);
				const refreshed = await refreshBuyerAccount(signal, forceRefresh);
				authenticationRequired = false;
				return refreshed;
			};
			if ((this.accountRefresh || account) && !anonymous) token = await refreshAccount();
			const payload = JSON.stringify(body);
			const send = () => {
				signal.throwIfAborted();
				this.requireWriteAccess(canDispatch);
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
				this.requireWriteAccess(canDispatch);
				if (current()) this.authRequired = true;
				this.accountRefresh = true;
				token = await refreshAccount(true);
				response = await send();
			}
			if (response.ok && current()) this.authRequired = false;
			authenticationRequired = response.status === 401 && !anonymous;
			const result: unknown = await response.json();
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
			throw new DiscussionRequestError(
				error instanceof Error ? error.message : 'We couldn’t save this message. Try again.',
				error instanceof Error && 'status' in error && typeof error.status === 'number'
					? error.status
					: undefined,
				authenticationRequired
			);
		}
	}

	async loadBuyerViewer(requiredAuthor = this.requiredAuthor) {
		const current = this.captureWriteAccess();
		if (!current()) return;
		const account = Boolean(requiredAuthor && !this.requiredBuyer);
		const forceBuyer = Boolean(requiredAuthor && this.requiredBuyer);
		const actor = account
			? `account:${requiredAuthor}`
			: forceBuyer || this.anonymous
				? 'buyer'
				: 'automatic';
		const mode = JSON.stringify([actor, this.activityGeneration]);
		this.attempt?.abort();
		const attempt = (this.attempt = new ReadAttempt(15_000));
		try {
			const access = this.access;
			let promise: Promise<DiscussionAuthor & { account?: boolean }>;
			if (!this.privateAccess) {
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
					) as Promise<DiscussionAuthor & { account?: boolean }>;
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
					{ ...access, ...this.privateAccess },
					attempt.signal
				);
			}
			const viewer = await waitForRead(promise, attempt.signal);
			if (this.attempt !== attempt || !current()) return;
			if (requiredAuthor && viewer.key !== requiredAuthor)
				throw new Error('Reconnect as the original author.');
			this.viewerAccount = Boolean(this.privateAccess || viewer.account);
			this.viewerIdentity = viewer;
			this.viewerBootstrapped = true;
			this.viewerError = null;
			this.requiredAuthor = undefined;
			this.authRequired = false;
			if (
				this.activeComposer &&
				this.activeComposer.kind !== 'edit' &&
				this.activeComposer.text.trim()
			)
				this.preparePostAccount();
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
			!this.activeComposer?.busy &&
			!this.activeComposer?.awaitingConfirmation &&
			!this.deletingMessageId
		);
	}

	async continueAsBuyer() {
		if (!this.canContinueAsBuyer) return;
		this.cancelAccountPreparation();
		this.activeComposer = null;
		this.selectedThread = null;
		this.anonymous = true;
		this.requiredAuthor = undefined;
		this.viewerIdentity = undefined;
		this.authRequired = false;
		await this.loadBuyerViewer();
	}

	private async write(
		command: DiscussionCommand,
		operationId: string,
		requiredAuthor?: string,
		requiredBuyer = false
	): Promise<DiscussionWriteResult> {
		const current = this.captureWriteAccess();
		this.requireWriteAccess(current);
		if (command.kind !== 'delete' && !validDiscussionText(command.text))
			throw new Error('Enter a message of 20,000 characters or fewer.');
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
			throw new Error('Reconnect as the original author.');
		if (!this.viewer) throw new Error(this.error ?? 'Reconnect before posting.');

		const authorKey = this.viewer.key;
		const account = this.viewerAccount;
		const original = { token: this.access.token, operationId, command };
		try {
			return !this.privateAccess
				? ((await this.buyerRequest(
						{ kind: 'write', expectedAuthorKey: authorKey, ...original },
						AbortSignal.timeout(15_000),
						account,
						!account,
						current,
						current
					)) as DiscussionWriteResult)
				: await waitForRead(
						this.client.mutation(api.discussions.write, { ...this.privateAccess, ...original }),
						AbortSignal.timeout(15_000)
					);
		} catch (error) {
			if (
				current() &&
				((error instanceof DiscussionRequestError && error.authenticationRequired) ||
					(error instanceof Error && 'status' in error && error.status === 401))
			) {
				this.requiredAuthor = authorKey;
				this.requiredBuyer = !account;
				this.viewerIdentity = undefined;
				this.authRequired = true;
			}
			throw error;
		}
	}

	private setSubmissionError(composer: ActiveComposer, error: unknown, fallback: string) {
		if (isDefiniteDiscussionError(error)) {
			composer.awaitingConfirmation = false;
			composer.operationId = crypto.randomUUID();
			composer.error =
				error instanceof Error && !(error instanceof ConvexError)
					? error.message
					: saveError(error, fallback);
		} else {
			composer.error = UNCERTAIN_WRITE_MESSAGE;
		}
	}

	async submit() {
		const composer = this.composer;
		if (!composer || composer.busy || !validDiscussionText(composer.text)) return;
		const current = this.captureWriteAccess();
		const text = composer.text;
		const anchor = $state.snapshot(composer.anchor);
		const contentRevision = composer.contentRevision;
		const operationId = composer.operationId;
		composer.busy = true;
		composer.awaitingConfirmation = true;
		composer.error = null;
		try {
			const result = await this.write(
				{ kind: 'create', anchor, contentRevision, text },
				operationId
			);
			if (current() && this.activeComposer === composer) {
				this.activeComposer = null;
				if (this.selectedThread === 'composer') this.selectedThread = result.threadId;
			}
		} catch (error) {
			if (current() && this.activeComposer === composer) {
				this.setSubmissionError(composer, error, 'We couldn’t post this message. Try again.');
			}
		} finally {
			composer.busy = false;
		}
	}

	async submitReply(id: Id<'discussionThreads'>) {
		const composer = this.replyComposer(id);
		if (this.readOnly || !composer || composer.busy || !validDiscussionText(composer.text)) return;
		const current = this.captureWriteAccess();
		const text = composer.text;
		const operationId = composer.operationId;
		composer.busy = true;
		composer.awaitingConfirmation = true;
		composer.error = null;
		try {
			await this.write({ kind: 'reply', threadId: id, text }, operationId);
			if (current() && this.activeComposer === composer) this.activeComposer = null;
		} catch (error) {
			if (current() && this.activeComposer === composer) {
				this.setSubmissionError(composer, error, 'We couldn’t reply. Try again.');
			}
		} finally {
			composer.busy = false;
		}
	}

	async submitEdit(id: Id<'discussionMessages'>) {
		const composer = this.editComposer(id);
		if (this.readOnly || !composer || composer.busy) return;
		const current = this.captureWriteAccess();
		const { expected, text, authorKey, account, operationId } = composer;
		composer.busy = true;
		composer.awaitingConfirmation = true;
		composer.error = null;
		try {
			await this.write(
				{ kind: 'edit', messageId: id, expectedRevision: expected, text },
				operationId,
				authorKey,
				!account
			);
			if (current() && this.activeComposer === composer) this.activeComposer = null;
		} catch (error) {
			if (current() && this.activeComposer === composer) {
				this.setSubmissionError(composer, error, 'We couldn’t save this message. Try again.');
			}
		} finally {
			composer.busy = false;
		}
	}

	async deleteMessage(
		message: Infer<typeof import('./validators').discussionMessage>,
		threadId: Id<'discussionThreads'>,
		reply: boolean,
		operationId: string = crypto.randomUUID()
	): Promise<DeleteMessageResult> {
		if (this.readOnly || this.deletingMessageId || this.activeComposer?.busy)
			return { status: 'ignored' };
		const current = this.captureWriteAccess();
		this.deletingMessageId = message.id;
		try {
			const result = await this.write(
				{
					kind: 'delete',
					messageId: message.id,
					expectedRevision: message.revision,
					target: reply ? 'reply' : 'thread'
				},
				operationId,
				message.author.key,
				!this.account
			);
			if (!current()) return { status: 'ignored' };
			if (!reply && this.selectedThread === result.threadId) this.selectedThread = null;
			if (
				(this.activeComposer?.kind === 'edit' && this.activeComposer.messageId === message.id) ||
				(!reply &&
					(this.activeComposer?.kind === 'reply' || this.activeComposer?.kind === 'edit') &&
					this.activeComposer.threadId === result.threadId)
			) {
				this.activeComposer = null;
			}
			return { status: 'deleted' };
		} catch (error) {
			if (!current()) return { status: 'ignored' };
			return {
				status: 'error',
				message:
					error instanceof Error && !(error instanceof ConvexError)
						? error.message
						: saveError(error, 'We couldn’t delete this message. Try again.'),
				definite: isDefiniteDiscussionError(error)
			};
		} finally {
			if (current() && this.deletingMessageId === message.id) this.deletingMessageId = null;
		}
	}

	destroy() {
		this.setActive(false);
		this.alive = false;
		this.stopAccess();
		this.feed.destroy();
		this.cancelAccountPreparation();
		this.activeComposer = null;
		this.deletingMessageId = null;
		this.actorDrafts.clear();
	}
}
