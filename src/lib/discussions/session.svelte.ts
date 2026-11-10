import { ReplyDiscussion } from './reply-state.svelte';
import { ReadAttempt, waitForRead } from '../auth/attempt';
import { SvelteMap } from 'svelte/reactivity';
import { coordinateDiscussionViewer } from './viewer-bootstrap';
import { LiveDiscussionPages } from './live-pages.svelte';
import type { ConvexClient } from 'convex/browser';
import type { Infer } from 'convex/values';
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
export type DiscussionThread = Infer<typeof discussionThread>;
export type DiscussionAuthor = Infer<typeof publicAuthor>;
export type DiscussionAccess =
	{ token: string } | { membershipId: Id<'memberships'>; id: Id<'savedContracts'> };
export { discussionPage } from './live-pages.svelte';
export type ReplyDraft = { text: string; busy: boolean; error: string | null; open: boolean };
export type EditDraft = ReplyDraft & { expected: number; authorKey: string };
export class DiscussionSession {
	readonly feed: LiveDiscussionPages<DiscussionThread>;
	private recent = $state.raw<DiscussionThread[]>([]);
	private created = new Map<Id<'discussionThreads'>, (() => void) | undefined>();
	private recentGeneration = 0;
	readonly threads = $derived.by(() => [
		...new Map([...this.recent, ...this.feed.rows].map((row) => [row.id, row])).values()
	]);
	private showCreatedThread(id: Id<'discussionThreads'>) {
		if (!this.alive) return;
		if (!this.created.has(id)) this.created.set(id, undefined);
		while (this.created.size > 20) {
			const oldest = [...this.created.keys()].find((key) => key !== this.selected)!;
			this.created.get(oldest)?.();
			this.created.delete(oldest);
			this.recent = this.recent.filter((row) => row.id !== oldest);
		}
		this.reconcileCreated();
	}
	private reconcileCreated() {
		const primary = new Set(this.feed.rows.map((row) => row.id));
		if (!this.feed.authorized)
			for (const replies of this.replies.values()) replies.setActive(false);
		for (const [id, stop] of this.created) {
			if (!this.active || !this.feed.authorized || primary.has(id)) {
				stop?.();
				this.created.set(id, undefined);
				this.recent = this.recent.filter((row) => row.id !== id);
			} else if (!stop) {
				const generation = this.recentGeneration;
				let owned = true;
				const release = this.client.onUpdate(
					api.discussions.thread,
					{ access: this.access, threadId: id },
					(row) => {
						if (
							!owned ||
							!this.feed.authorized ||
							!this.alive ||
							!this.active ||
							generation !== this.recentGeneration ||
							!this.created.has(id)
						)
							return;
						this.recent = [...this.recent.filter((t) => t.id !== id), ...(row ? [row] : [])];
						if (!row) {
							this.created.get(id)?.();
							this.created.delete(id);
						}
					},
					(error) => {
						if (!owned || !this.active || generation !== this.recentGeneration) return;
						this.feed.refuse(error);
					}
				);
				const stop = () => {
					owned = false;
					release();
				};
				if (this.created.has(id) && this.feed.authorized && this.active) this.created.set(id, stop);
				else stop();
			}
		}
	}
	private replies = new Map<string, ReplyDiscussion>();
	replyState(id: Id<'discussionThreads'>) {
		let state = this.replies.get(id);
		if (!state) {
			state = new ReplyDiscussion(this.client, this.access, id);
			this.replies.set(id, state);
		}
		return state;
	}

	viewer = $state.raw<DiscussionAuthor>();
	private viewerError = $state<string | null>(null);
	get error() {
		return this.viewerError ?? this.feed.error?.message ?? null;
	}
	get loading() {
		return this.feed.loading;
	}
	get done() {
		return this.feed.done;
	}
	active = $state(false);
	selected = $state<string | null>(null);
	composer = $state.raw<{
		anchor: DiscussionAnchor;
		type: 'comment' | 'proposal';
		revision: number;
	} | null>(null);
	text = $state('');
	submitting = $state(false);
	composeError = $state<string | null>(null);
	onApply?: (thread: DiscussionThread) => Promise<void>;
	private subscriptions: (() => void)[] = [];
	private attempt?: ReadAttempt;
	authRequired = $state(false);
	private anonymous = false;
	private accountRefresh = false;
	private operations = new Map<string, { id: string; authorKey: string; buyer: boolean }>();
	private alive = true;
	private viewerLoad?: { mode: string; promise: Promise<DiscussionAuthor> };
	private requiredAuthor?: string;
	private requiredBuyer = false;
	readonly replyDrafts = new SvelteMap<string, ReplyDraft>();
	readonly editDrafts = new SvelteMap<string, EditDraft>();
	replyDraft(id: string) {
		const retained = this.replyDrafts.get(id);
		if (retained) return retained;
		const draft = $state<ReplyDraft>({ text: '', busy: false, error: null, open: false });
		this.replyDrafts.set(id, draft);
		return draft;
	}
	editDraft(id: string) {
		const retained = this.editDrafts.get(id);
		if (retained) return retained;
		const draft = $state<EditDraft>({
			text: '',
			busy: false,
			error: null,
			open: false,
			expected: 0,
			authorKey: ''
		});
		this.editDrafts.set(id, draft);
		return draft;
	}
	constructor(
		readonly client: ConvexClient,
		readonly access: DiscussionAccess,
		readonly revision: () => number
	) {
		this.feed = new LiveDiscussionPages(
			(opts, receive, fail) =>
				client.onUpdate(api.discussions.threads, { access, paginationOpts: opts }, receive, fail),
			() => this.reconcileCreated()
		);
	}
	setActive(active: boolean) {
		if (!this.alive || this.active === active) return;
		this.active = active;
		this.recentGeneration++;
		for (const [id, stop] of this.created) {
			stop?.();
			this.created.set(id, undefined);
		}
		if (!active) for (const replies of this.replies.values()) replies.setActive(false);
		for (const stop of this.subscriptions) stop();
		this.subscriptions = [];
		this.attempt?.abort();
		this.attempt = undefined;
		if (!active) {
			this.feed.stop();
			return;
		}
		this.feed.reset();
		this.reconcileCreated();
		const generation = this.recentGeneration;
		if ('membershipId' in this.access)
			this.subscriptions.push(
				this.client.onUpdate(
					api.discussions.viewer,
					this.access,
					(v) => {
						if (!this.active || generation !== this.recentGeneration) return;
						this.viewer = v;
						this.viewerError = null;
					},
					() => {
						if (!this.active || generation !== this.recentGeneration) return;
						this.viewer = undefined;
						this.viewerError = 'Reconnect your account to comment. Your draft is still here.';
					}
				)
			);
	}
	private async buyerRequest(
		body: unknown,
		signal?: AbortSignal,
		account = false,
		forceBuyer = false,
		current: () => boolean = () => this.alive
	) {
		const requestSignal = signal;
		const anonymous = forceBuyer || (this.anonymous && !account);
		let token: string | undefined;
		const refreshAccount = async () => {
			const { refreshBuyerAccount } = await import('../auth/buyer-discussion-auth');
			return refreshBuyerAccount(requestSignal ?? AbortSignal.timeout(15_000));
		};
		if ((this.accountRefresh || account) && !anonymous) token = await refreshAccount();
		const send = () =>
			fetch('/api/buyer/discussions', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { Authorization: `Bearer ${token}` } : {}),
					...(anonymous ? { 'X-Discussion-Actor': 'buyer' } : {})
				},
				credentials: 'same-origin',
				cache: 'no-store',
				body: JSON.stringify(body),
				signal: requestSignal
			});
		let response = await send();
		if (response.status === 401 && !anonymous) {
			if (current()) this.authRequired = true;
			this.accountRefresh = true;
			token = await refreshAccount();
			response = await send();
		}
		if (response.ok && current()) this.authRequired = false;

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
	}
	async loadBuyerViewer(requiredAuthor = this.requiredAuthor) {
		if (!('token' in this.access) || !this.active) return;
		const account = Boolean(requiredAuthor && !this.requiredBuyer);
		const forceBuyer = Boolean(requiredAuthor && this.requiredBuyer);
		const mode = account
			? `account:${requiredAuthor}`
			: forceBuyer || this.anonymous
				? 'buyer'
				: 'automatic';
		this.attempt?.abort();
		const attempt = (this.attempt = new ReadAttempt(15_000));
		try {
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
			let load = this.viewerLoad;
			if (!load) {
				const token = this.access.token;
				const promise = coordinateDiscussionViewer(() =>
					this.buyerRequest({ kind: 'viewer', token }, undefined, account, forceBuyer, () => false)
				) as Promise<DiscussionAuthor>;
				load = this.viewerLoad = { mode, promise };
				const owned = load;
				const release = () => {
					if (this.viewerLoad === owned) this.viewerLoad = undefined;
				};
				void promise.then(release, release);
			}
			const viewer = await waitForRead(load.promise, attempt.signal);
			if (this.attempt !== attempt || !this.alive) return;
			if (requiredAuthor && viewer.key !== requiredAuthor)
				throw new Error('Reconnect as the original author. Your draft is still here.');
			this.viewer = viewer;
			this.viewerError = null;
			this.requiredAuthor = undefined;
			this.authRequired = false;
		} catch (error) {
			if (this.attempt !== attempt || !this.alive || !this.active) return;
			this.viewer = undefined;
			this.authRequired = account || this.authRequired;
			this.viewerError =
				error instanceof Error ? error.message : 'Comments are unavailable. Try again.';
		} finally {
			attempt.complete();
		}
	}
	get canContinueAsBuyer() {
		return this.operations.size === 0;
	}
	async continueAsBuyer() {
		if (!this.canContinueAsBuyer || this.submitting) return;
		this.anonymous = true;
		this.requiredAuthor = undefined;
		this.viewer = undefined;
		this.authRequired = false;
		await this.loadBuyerViewer();
	}
	retry() {
		if (this.viewerError) {
			if ('token' in this.access) void this.loadBuyerViewer();
			else {
				this.setActive(false);
				this.setActive(true);
				return;
			}
		}
		this.feed.retry();
	}
	loadMore() {
		if (this.feed.error || !this.feed.authorized) this.retry();
		else this.feed.loadMore();
	}
	begin(anchor: DiscussionAnchor, type: 'comment' | 'proposal') {
		if (this.submitting) return;
		this.composer = { anchor, type, revision: this.revision() };
		this.text = '';
		this.composeError = null;
		this.selected = 'composer';
		if ('token' in this.access) void this.loadBuyerViewer();
	}
	cancel() {
		if (!this.submitting) {
			this.composer = null;
			this.text = '';
			this.composeError = null;
			this.selected = null;
		}
	}
	async write(
		command: Infer<typeof discussionCommand>,
		requiredAuthor?: string,
		requiredBuyer = false
	): Promise<Infer<typeof writeResult>> {
		if (requiredAuthor && this.viewer?.key !== requiredAuthor) {
			this.requiredAuthor = requiredAuthor;
			this.requiredBuyer = requiredBuyer;
			this.authRequired = true;
			if ('token' in this.access) await this.loadBuyerViewer(requiredAuthor);
		}
		if (
			'token' in this.access &&
			(!this.viewer || (!requiredAuthor && this.anonymous && !this.viewer.buyer))
		)
			await this.loadBuyerViewer(requiredAuthor);
		if (requiredAuthor && this.viewer?.key !== requiredAuthor)
			throw new Error('Reconnect as the original author. Your draft is still here.');
		if (!this.viewer)
			throw new Error(this.error ?? 'Reconnect before posting. Your draft is still here.');
		const fingerprint = JSON.stringify(command);
		let operation = this.operations.get(fingerprint);
		if (!operation) {
			operation = { id: crypto.randomUUID(), authorKey: this.viewer.key, buyer: this.viewer.buyer };
			this.operations.set(fingerprint, operation);
		}
		if (operation.authorKey !== this.viewer.key) {
			this.requiredAuthor = operation.authorKey;
			this.requiredBuyer = operation.buyer;
			this.authRequired = true;
			throw new Error(
				'Reconnect as the original author before retrying this message. Your draft is still here.'
			);
		}
		const operationId = operation.id;
		let result: Infer<typeof writeResult>;
		try {
			if ('membershipId' in this.access)
				result = await this.client.mutation(api.discussions.write, {
					...this.access,
					operationId,
					command
				});
			else
				result = (await this.buyerRequest(
					{
						kind: 'write',
						expectedAuthorKey: operation.authorKey,
						token: this.access.token,
						operationId,
						command
					},
					AbortSignal.timeout(15_000),
					!operation.buyer,
					operation.buyer
				)) as Infer<typeof writeResult>;
		} catch (error) {
			if (this.alive && error instanceof Error && 'status' in error && error.status === 401) {
				this.requiredAuthor = operation.authorKey;
				this.requiredBuyer = operation.buyer;
				this.viewer = undefined;
				this.authRequired = true;
			}
			throw error;
		}
		this.operations.delete(fingerprint);
		if (this.alive && command.kind === 'reply')
			this.replyState(result.threadId).showCreated(result.messageId);
		return result;
	}
	async submit() {
		const composer = this.composer;
		if (!composer || this.submitting || !this.text.trim()) return;
		this.submitting = true;
		this.composeError = null;
		try {
			const result = await this.write({ kind: 'create', ...composer, text: this.text });
			if (this.alive) {
				this.composer = null;
				this.text = '';
				this.selected = result.threadId;
				this.showCreatedThread(result.threadId);
			}
		} catch (error) {
			if (this.alive)
				this.composeError =
					error instanceof Error && error.name !== 'ConvexError'
						? error.message
						: saveError(error, 'We couldn’t post this message. Your draft is still here.');
		} finally {
			this.submitting = false;
		}
	}
	destroy() {
		this.setActive(false);
		this.alive = false;
		this.operations.clear();
		this.replyDrafts.clear();
		this.editDrafts.clear();
		this.feed.destroy();
		for (const state of this.replies.values()) state.destroy();
		this.replies.clear();
		this.created.clear();
		this.recent = [];
	}
}
