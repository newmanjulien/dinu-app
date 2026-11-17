import { createOperationId } from '../contract/operation-identity';
import {
	assertOperationRetryable,
	isOperationRecovery,
	operationResultError,
	OperationResultFailure
} from '../contract/operation-recovery';
import { subscribeNativePage } from '../native-pagination';
import { ReplyDiscussion, ReplyLoadScheduler } from './reply-state.svelte';
import { DiscussionReads } from './reads.svelte';
import { ReadAttempt, waitForRead } from '../auth/attempt';
import {
	DiscussionWork,
	type DiscussionRecovery,
	type CreateComposerState,
	type DiscussionOperation,
	type ReplyComposerState,
	type EditComposerState
} from './recovery.svelte';
export type { ReplyComposerState, EditComposerState } from './recovery.svelte';
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
	discussionMessage,
	discussionThread,
	publicAuthor,
	writeResult
} from './validators';
import { saveError } from '../contract/saved';
import { awaitContractOperation } from '../contract/operation-result';
import type { completedWriteResult, discussionOperationResult } from './validators';
import { validate } from 'convex-helpers/validators';
import { SvelteMap } from 'svelte/reactivity';
import { completedWriteResult as completedResult } from './validators';
export type DiscussionThread = Infer<typeof discussionThread>;
export type DiscussionAuthor = Infer<typeof publicAuthor>;
type ProvisionalBase = {
	source: string;
	operationId: string;
	text: string;
	author: DiscussionAuthor;
	authorKey: string | null;
	account: boolean | null;
	localOrder: number;
	messageId?: Id<'discussionMessages'>;
	failed?: boolean;
	failureMessage?: string;
};
export type ProvisionalPost = ProvisionalBase &
	(
		| {
				kind: 'create';
				anchor: DiscussionAnchor;
				type: 'comment' | 'proposal';
				contentIdentity: string;
				revision: number;
				deleteSelectedWording: boolean;
		  }
		| { kind: 'reply'; threadId: Id<'discussionThreads'> }
	);
type ProvisionalRoot = Extract<ProvisionalPost, { kind: 'create' }>;
type ProvisionalReply = Extract<ProvisionalPost, { kind: 'reply' }>;
type Message = Infer<typeof discussionMessage>;
type DisplayPost<Saved, Pending extends ProvisionalPost> =
	| { kind: 'saved'; key: string; createdAt: number; sortId: string; saved: Saved }
	| { kind: 'provisional'; key: string; localOrder: number; post: Pending };
function matchesProvisionalPost(post: ProvisionalPost, message: Message) {
	return message.operationId === post.operationId || message.id === post.messageId;
}
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
class DiscussionResultUnavailable extends Error {}
function createCommand(composer: CreateComposerState): Infer<typeof discussionCommand> {
	return {
		kind: 'create',
		anchor: composer.anchor,
		type: composer.type,
		revision: composer.revision,
		contentIdentity: composer.contentIdentity,
		text: composer.text
	};
}
export class DiscussionSession {
	work = $state.raw(new DiscussionWork());
	private operationAuthor = $state.raw<{ key: string; account: boolean }>();
	readonly reads = new DiscussionReads();
	readonly feed: LiveDiscussionPages<DiscussionThread>;
	private get actorPrivateAccess() {
		return this.actorTransport?.()?.privateAccess ?? this.privateAccess;
	}
	private get actorClient() {
		return this.actorTransport?.()?.client ?? this.client;
	}
	private retention = new DiscussionRetention();
	private recent = $state.raw<DiscussionThread[]>([]);
	readonly provisionalPosts = new SvelteMap<string, ProvisionalPost>();
	private postedIdentity = new Map<Id<'discussionMessages'>, string>();
	private nextLocalOrder = 0;
	get provisionalRoots() {
		return [...this.provisionalPosts.values()].filter(
			(post): post is ProvisionalRoot => post.kind === 'create'
		);
	}
	provisionalReplies(threadId: Id<'discussionThreads'>) {
		return [...this.provisionalPosts.values()].filter(
			(post): post is ProvisionalReply => post.kind === 'reply' && post.threadId === threadId
		);
	}
	private rememberPostedIdentity(post: ProvisionalPost, messageId: Id<'discussionMessages'>) {
		this.postedIdentity.set(messageId, post.operationId);
	}
	private displayPosts<Saved, Pending extends ProvisionalPost>(
		saved: Saved[],
		pending: Pending[],
		messageOf: (row: Saved) => Message
	): DisplayPost<Saved, Pending>[] {
		const byOperation = new Map(pending.map((post) => [post.operationId, post]));
		const byMessage = new Map(
			pending.flatMap((post) => (post.messageId ? [[post.messageId, post] as const] : []))
		);
		const matched = new Set<Pending>();
		const rows: DisplayPost<Saved, Pending>[] = saved.map((row) => {
			const message = messageOf(row);
			const post =
				(message.operationId && byOperation.get(message.operationId)) || byMessage.get(message.id);
			if (post) matched.add(post);
			const identity = this.postedIdentity.get(message.id);
			const operationId = post?.operationId ?? identity ?? message.operationId;
			return {
				kind: 'saved',
				key: operationId ? `post:${operationId}` : message.id,
				createdAt: message.createdAt,
				sortId: message.id,
				saved: row
			};
		});
		for (const post of pending) {
			if (matched.has(post)) continue;
			rows.push({
				kind: 'provisional',
				key: `post:${post.operationId}`,
				localOrder: post.localOrder,
				post
			});
		}
		return rows.sort((a, b) => {
			if (a.kind === 'provisional' && b.kind === 'provisional') return a.localOrder - b.localOrder;
			if (a.kind === 'provisional') return 1;
			if (b.kind === 'provisional') return -1;
			return a.createdAt - b.createdAt || a.sortId.localeCompare(b.sortId);
		});
	}
	get displayRoots() {
		const pending = this.feed.authorized && !this.readOnly ? this.provisionalRoots : [];
		return this.displayPosts(this.threads, pending, (thread) => thread.root).map((row) =>
			row.kind === 'saved'
				? {
						kind: 'thread' as const,
						key: row.key,
						id: row.saved.id,
						anchor: row.saved.anchor,
						type: row.saved.type,
						available: this.feed.authorized,
						thread: row.saved
					}
				: {
						kind: 'provisional' as const,
						key: row.key,
						id: `pending:${row.post.source}`,
						anchor: row.post.anchor,
						type: row.post.type,
						available: row.post.contentIdentity === this.contentIdentity(),
						post: row.post
					}
		);
	}
	displayReplies(threadId: Id<'discussionThreads'>, rows: Message[]) {
		return this.displayPosts(
			rows,
			this.readOnly ? [] : this.provisionalReplies(threadId),
			(message) => message
		);
	}
	reconcileProvisionalReplies(threadId: Id<'discussionThreads'>, rows: Message[]) {
		for (const post of this.provisionalReplies(threadId)) {
			const message = rows.find((row) => matchesProvisionalPost(post, row));
			if (message) {
				this.rememberPostedIdentity(post, message.id);
				this.provisionalPosts.delete(post.source);
			}
		}
	}
	private provisionalAuthor(authorKey: string | null, account: boolean | null): DiscussionAuthor {
		return (
			this.viewer ?? {
				key: authorKey ?? '',
				name: 'You',
				avatarUrl: null,
				buyer: account === false
			}
		);
	}
	private showProvisional(
		composer: CreateComposerState | ReplyComposerState,
		operationId: string,
		text: string
	) {
		const base = {
			source: composer.id,
			operationId,
			text,
			author: this.provisionalAuthor(composer.authorKey, composer.account),
			authorKey: composer.authorKey,
			account: composer.account,
			localOrder: this.nextLocalOrder++
		};
		this.provisionalPosts.set(
			composer.id,
			composer.kind === 'create'
				? {
						...base,
						kind: 'create',
						anchor: composer.anchor,
						type: composer.type,
						contentIdentity: composer.contentIdentity,
						revision: composer.revision,
						deleteSelectedWording: composer.deleteSelectedWording
					}
				: { ...base, kind: 'reply', threadId: composer.threadId }
		);
	}
	private restoreProvisional(source: string) {
		const post = this.provisionalPosts.get(source);
		if (!post) return;
		const anotherReplyOpen = [...this.work.replies.values()].some(
			(composer) => composer.open && composer.id !== source
		);
		if (this.work.composer?.id === source && post.kind === 'create' && !anotherReplyOpen) {
			this.provisionalPosts.delete(source);
			this.work.composer.text = post.text;
			this.work.composer.deleteSelectedWording = post.deleteSelectedWording;
			this.work.composer.open = true;
			this.selected = 'composer';
		} else if (post.kind === 'reply') {
			const composer = this.work.replies.get(post.threadId);
			if (composer?.id === source && !anotherReplyOpen && !this.work.composer?.open) {
				this.provisionalPosts.delete(source);
				composer.text = post.text;
				composer.open = true;
				this.selected = post.threadId;
				this.replyingTo = post.threadId;
			} else {
				this.provisionalPosts.set(source, { ...post, failed: true });
			}
		} else this.provisionalPosts.set(source, { ...post, failed: true });
	}
	private setProvisionalFailure(source: string, message: string) {
		const post = this.provisionalPosts.get(source);
		if (post?.failed) this.provisionalPosts.set(source, { ...post, failureMessage: message });
	}
	canRestorePost(source: string) {
		const post = this.provisionalPosts.get(source);
		if (!post?.failed) return false;
		return post.kind === 'create'
			? !this.work.composer?.open &&
					![...this.work.replies.values()].some((composer) => composer.open)
			: !this.work.composer?.open &&
					!this.hasReplyOperation(post.threadId) &&
					![...this.work.replies.values()].some((composer) => composer.open);
	}
	restorePostDraft(source: string) {
		if (!this.canRestorePost(source)) return;
		const post = this.provisionalPosts.get(source)!;
		if (post.kind === 'create') {
			this.work.composer = {
				id: crypto.randomUUID(),
				kind: 'create',
				authorKey: post.authorKey,
				account: post.account,
				text: post.text,
				open: true,
				busy: false,
				error: post.failureMessage ?? 'We couldn’t post this message. Try again.',
				anchor: post.anchor,
				type: post.type,
				revision: post.revision,
				contentIdentity: post.contentIdentity,
				deleteSelectedWording: post.deleteSelectedWording
			};
			this.selected = 'composer';
		} else {
			const composer = this.ensureReplyComposer(post.threadId);
			composer.text = post.text;
			composer.open = true;
			composer.error = post.failureMessage ?? 'We couldn’t reply. Try again.';
			this.selected = post.threadId;
			this.replyingTo = post.threadId;
		}
		this.provisionalPosts.delete(source);
	}
	private created = new Map<Id<'discussionThreads'>, (() => void) | undefined>();
	private createdSnapshots = new Map<Id<'discussionThreads'>, boolean>();
	private createdSnapshotController?: AbortController;
	private createdSnapshotId?: Id<'discussionThreads'>;
	private recentGeneration = 0;
	private deletedThreads = $state.raw(new Set<Id<'discussionThreads'>>());
	readonly threads = $derived.by(() =>
		this.feed.authorized
			? [
					...new Map([...this.recent, ...this.feed.rows].map((row) => [row.id, row])).values()
				].filter((row) => !this.deletedThreads.has(row.id))
			: []
	);
	private acknowledgeCreated(id: Id<'discussionThreads'>) {
		for (const [operationId, threadId] of this.work.created) {
			if (threadId === id) this.work.created.delete(operationId);
		}
	}
	private stopCreatedSnapshot(id?: Id<'discussionThreads'>) {
		if (!id || this.createdSnapshotId === id) {
			this.createdSnapshotController?.abort();
			this.createdSnapshotController = undefined;
			this.createdSnapshotId = undefined;
		}
		if (id) this.createdSnapshots.delete(id);
		else this.createdSnapshots.clear();
	}
	private loadCreatedSnapshots() {
		if (
			this.createdSnapshotController ||
			!this.alive ||
			!this.active ||
			!this.feed.authorized ||
			!this.feed.firstPageAccepted
		)
			return;
		const id = [...this.createdSnapshots].find(([, loaded]) => !loaded)?.[0];
		if (!id) return;
		const controller = new AbortController(),
			generation = this.recentGeneration;
		this.createdSnapshotController = controller;
		this.createdSnapshotId = id;
		const current = () =>
			this.createdSnapshotController === controller &&
			this.alive &&
			this.active &&
			this.feed.authorized &&
			generation === this.recentGeneration &&
			this.createdSnapshots.has(id);
		void queryOnce(
			this.client,
			api.discussions.thread,
			{ access: this.access, threadId: id },
			controller.signal
		)
			.then((row) => {
				if (!current()) return;
				this.createdSnapshots.set(id, true);
				if (row) {
					this.recent = [...this.recent.filter((thread) => thread.id !== id), row];
					this.reconcileCreateOutcomes();
				}
			})
			.catch((error) => {
				if (!current()) return;
				this.createdSnapshots.set(id, true);
				this.feed.refuse(error instanceof Error ? error : new Error('Comments are unavailable.'));
			})
			.finally(() => {
				if (this.createdSnapshotController !== controller) return;
				this.createdSnapshotController = undefined;
				this.createdSnapshotId = undefined;
				this.loadCreatedSnapshots();
			});
	}
	reconcileCreateOutcomes() {
		if (!this.alive || !this.active || !this.feed.authorized || !this.feed.firstPageAccepted)
			return;
		const threads = this.threads;
		for (const post of this.provisionalRoots) {
			const thread = threads.find((row) => matchesProvisionalPost(post, row.root));
			if (!thread) continue;
			this.rememberPostedIdentity(post, thread.root.id);
			if (this.selected === `pending:${post.source}`) this.selected = thread.id;
			this.provisionalPosts.delete(post.source);
		}
		const primary = new Set(this.feed.currentRows.map((row) => row.id));
		const pending = new Set(this.work.created.values());
		for (const id of pending) {
			if (primary.has(id)) {
				this.acknowledgeCreated(id);
				this.stopCreatedSnapshot(id);
				this.recent = this.recent.filter((row) => row.id !== id);
				continue;
			}
			if (this.created.has(id) || this.createdSnapshots.has(id)) continue;
			if (this.created.size >= 20) {
				const oldest = [...this.created.keys()].find(
					(key) => key !== this.selected && !pending.has(key)
				);
				if (!oldest) {
					this.createdSnapshots.set(id, false);
					continue;
				}
				this.created.get(oldest)?.();
				this.created.delete(oldest);
				this.recent = this.recent.filter((row) => row.id !== oldest);
			}
			this.created.set(id, undefined);
		}
		this.reconcileCreated();
		this.loadCreatedSnapshots();
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
			this.stopCreatedSnapshot();
			for (const stop of this.created.values()) stop?.();
			this.created.clear();
			this.recent = [];
			for (const replies of this.replies.values()) replies.destroy();
			return;
		}
		if (!this.active || !this.feed.firstPageAccepted) {
			if (this.recent.length) this.feed.retainDisplay(this.retainedThreads());
			this.recent = [];
			this.stopCreatedSnapshot();
			for (const [id, stop] of this.created) {
				stop?.();
				this.created.set(id, undefined);
			}
			for (const replies of this.replies.values()) replies.setActive(false);
			return;
		}
		const primary = new Set(this.feed.currentRows.map((row) => row.id));
		for (const id of this.createdSnapshots.keys()) {
			if (!primary.has(id)) continue;
			this.stopCreatedSnapshot(id);
			this.recent = this.recent.filter((row) => row.id !== id);
			this.acknowledgeCreated(id);
		}
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
							if (row) this.reconcileCreateOutcomes();
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
	private replyLoadScheduler = new ReplyLoadScheduler();
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
			state = new ReplyDiscussion(
				this.client,
				this.access,
				id,
				this.replyLoadScheduler,
				this.retention
			);
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
		return Boolean(this.actorPrivateAccess || this.viewerAccount);
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
		return this.readOnly ? null : this.work.composer;
	}
	get visibleComposerCard() {
		const composer = this.visibleComposer;
		if (!composer) return null;
		return composer.open ||
			(!this.provisionalPosts.has(composer.id) &&
				(this.hasOperationStatus(composer.id) ||
					(this.authRequired && this.work.operations.has(composer.id))))
			? composer
			: null;
	}
	get showReconnectCard() {
		return !this.readOnly && this.authRequired && !this.threads.length && !this.work.composer;
	}
	get hasVisibleRail() {
		return Boolean(this.displayRoots.length || this.visibleComposerCard || this.showReconnectCard);
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
		if (!current()) throw new Error('The discussion view changed. Reopen it and try again.');
	}
	private snapshotComposer<T extends CreateComposerState | ReplyComposerState | EditComposerState>(
		composer: T
	): T {
		return { ...$state.snapshot(composer), busy: false } as T;
	}
	private policyGeneration?: number;
	synchronizePolicy(generation: number) {
		if (generation === this.policyGeneration) return;
		this.policyGeneration = generation;
		this.cancelAccountPreparation();
		// Detach the consumer, never the owner of an already-dispatched cookie request.
		this.attempt?.abort();
		this.attempt = undefined;
		this.closeEditors();
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
	get replyingTo() {
		return [...this.work.replies.values()].find((composer) => composer.open)?.threadId ?? null;
	}
	set replyingTo(id: Id<'discussionThreads'> | null) {
		for (const composer of this.work.replies.values()) {
			if (composer.threadId !== id && composer.open) this.closeReplyComposer(composer);
		}
		if (id) {
			this.ensureReplyComposer(id).open = true;
			this.editingMessage = null;
		}
	}
	get editingMessage() {
		return [...this.work.edits.values()].find((composer) => composer.open)?.messageId ?? null;
	}
	set editingMessage(id: Id<'discussionMessages'> | null) {
		for (const composer of this.work.edits.values()) {
			if (composer.messageId !== id && composer.open) this.closeEditComposer(composer);
		}
		if (id) {
			this.ensureEditComposer(id).open = true;
			this.replyingTo = null;
		}
	}
	closeEditors() {
		this.replyingTo = null;
		this.editingMessage = null;
	}
	private writingComposer(composer: CreateComposerState | ReplyComposerState | EditComposerState) {
		return (
			composer.busy ||
			this.work.operations.has(composer.id) ||
			(composer.kind === 'edit' && this.work.operations.has(`delete:${composer.messageId}`))
		);
	}
	private closeReplyComposer(composer: ReplyComposerState) {
		composer.open = false;
		composer.text = '';
		if (!this.writingComposer(composer)) this.work.replies.delete(composer.threadId);
	}
	private closeEditComposer(composer: EditComposerState) {
		composer.open = false;
		composer.text = '';
		composer.initialized = false;
		composer.deleteSelectedWording = false;
		if (!this.writingComposer(composer)) this.work.edits.delete(composer.messageId);
	}
	private releaseClosedComposers() {
		const composer = this.work.composer;
		if (composer && !composer.open && !this.writingComposer(composer)) {
			this.work.composer = null;
			if (this.selected === 'composer') this.selected = null;
		}
		for (const composer of this.work.replies.values())
			if (!composer.open && !this.writingComposer(composer))
				this.work.replies.delete(composer.threadId);
		for (const composer of this.work.edits.values())
			if (!composer.open && !this.writingComposer(composer))
				this.work.edits.delete(composer.messageId);
	}
	collapseReply(threadId: Id<'discussionThreads'>) {
		if (this.replyingTo !== threadId) return;
		this.replyingTo = null;
	}
	collapseEdit(messageId: Id<'discussionMessages'>) {
		if (this.editingMessage !== messageId) return;
		this.editingMessage = null;
	}
	get selected() {
		return this.readOnly && this.selectedThread === 'composer' ? null : this.selectedThread;
	}
	private closeCreateComposer() {
		const composer = this.work.composer;
		if (!composer) return;
		composer.open = false;
		composer.text = '';
		composer.deleteSelectedWording = false;
		if (!this.writingComposer(composer)) this.work.composer = null;
	}
	set selected(id: string | null) {
		if (this.readOnly && id === 'composer') return;
		if (this.selectedThread !== id) {
			this.closeEditors();
			const composer = this.work.composer;
			if (composer && id !== 'composer') this.closeCreateComposer();
		}
		this.selectedThread = id;
	}
	private sellerIdentity?: string;
	private accountIdentity?: string;
	private viewerEpoch = 0;
	private activityGeneration = 0;
	private sellerAccount = $state(false);
	private resetWork() {
		this.cancelAccountPreparation();
		for (const stop of this.receipts.values()) stop();
		this.persistOperations();
		if (!this.operationAuthor) this.work.destroy();
		this.work = new DiscussionWork();
		this.provisionalPosts.clear();
		this.postedIdentity.clear();
		this.nextLocalOrder = 0;
		this.operationAuthor = undefined;
	}
	persistOperations() {
		const author = this.operationAuthor;
		if (author) this.recovery?.persist(author.key, author.account, this.work);
	}
	recognizeSeller(identity: string | undefined, accountIdentity = identity) {
		if (identity === this.sellerIdentity && accountIdentity === this.accountIdentity) return;
		this.resetWork();
		this.selected = null;
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
	private accountPreparation?: { attempt: ReadAttempt; promise: Promise<void> };
	private accountPreparedUntil = 0;
	private accountPreparationRetryAt = 0;
	private requiredAuthor?: string;
	private requiredBuyer = false;
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
					// Posting keeps its ordinary authentication and recovery path.
				})
				.finally(() => {
					attempt.complete();
					if (this.accountPreparation === preparation) this.accountPreparation = undefined;
				})
		};
		this.accountPreparation = preparation;
	}
	private prepareExistingPostDraft() {
		if (
			(this.work.composer?.open &&
				(Boolean(this.work.composer.text.trim()) || this.work.composer.deleteSelectedWording)) ||
			[...this.work.replies.values()].some((composer) => composer.open && composer.text.trim())
		)
			this.preparePostAccount();
	}
	updatePostText(composer: CreateComposerState | ReplyComposerState, text: string) {
		this.work.setText(composer, text);
		if (text.trim()) this.preparePostAccount();
	}
	updatePostDeletion(composer: CreateComposerState, deleting: boolean) {
		this.work.setDeletion(composer, deleting);
		if (deleting) this.preparePostAccount();
	}
	private cancelAccountPreparation() {
		this.accountPreparation?.attempt.abort();
		this.accountPreparation = undefined;
		this.accountPreparedUntil = 0;
		this.accountPreparationRetryAt = 0;
	}
	private bindViewerWork(authorKey: string, account: boolean) {
		let composers = [
			...(this.work.composer ? [this.work.composer] : []),
			...this.work.replies.values(),
			...this.work.edits.values()
		];
		if (
			composers.some(
				(composer) => composer.authorKey !== null && composer.authorKey !== authorKey
			) ||
			[...this.work.operations.values()].some((operation) => operation.authorKey !== authorKey)
		) {
			this.resetWork();
			this.viewerEpoch++;
			this.selected = null;
			composers = [];
		}
		for (const composer of composers) {
			if (composer.authorKey === null) composer.authorKey = authorKey;
			if (!this.work.operations.has(composer.id)) composer.account = account;
		}
		this.work = this.recovery?.claim(authorKey, account, this.work) ?? this.work;
		for (const operation of this.work.operations.values()) {
			if (this.provisionalPosts.has(operation.source) || operation.blocked) continue;
			const command = operation.command;
			if (command.kind === 'create')
				this.provisionalPosts.set(operation.source, {
					source: operation.source,
					operationId: operation.id,
					kind: 'create',
					anchor: command.anchor,
					type: command.type,
					contentIdentity: command.contentIdentity,
					revision: command.revision,
					deleteSelectedWording: command.type === 'proposal' && !command.text.length,
					text: command.text,
					author: this.provisionalAuthor(authorKey, account),
					authorKey,
					account,
					localOrder: this.nextLocalOrder++
				});
			else if (command.kind === 'reply')
				this.provisionalPosts.set(operation.source, {
					source: operation.source,
					operationId: operation.id,
					kind: 'reply',
					threadId: command.threadId,
					text: command.text,
					author: this.provisionalAuthor(authorKey, account),
					authorKey,
					account,
					localOrder: this.nextLocalOrder++
				});
		}
		this.operationAuthor = { key: authorKey, account };
		this.persistOperations();
		this.reconcileCreateOutcomes();
		this.reconcileOperations();
		this.prepareExistingPostDraft();
	}
	hasThreadOperation(id: Id<'discussionThreads'>) {
		return [...this.work.operations.values()].some(
			(operation) =>
				(operation.command.kind === 'reply' && operation.command.threadId === id) ||
				((operation.command.kind === 'edit' || operation.command.kind === 'delete') &&
					operation.threadId === id)
		);
	}
	hasReplyOperation(id: Id<'discussionThreads'>) {
		return [...this.work.operations.values()].some(
			(operation) => operation.command.kind === 'reply' && operation.command.threadId === id
		);
	}
	replyComposer(id: Id<'discussionThreads'>) {
		return this.work.replies.get(id);
	}
	ensureReplyComposer(id: Id<'discussionThreads'>) {
		const retained = this.replyComposer(id);
		if (retained) return retained;
		const composer = $state<ReplyComposerState>({
			id: crypto.randomUUID(),
			kind: 'reply',
			threadId: id,
			authorKey: this.viewerKey ?? null,
			account: this.viewerKey ? this.account : null,
			text: '',
			open: false,
			busy: false,
			error: null
		});
		this.work.replies.set(id, composer);
		return composer;
	}
	editComposer(id: Id<'discussionMessages'>) {
		return this.work.edits.get(id);
	}
	ensureEditComposer(id: Id<'discussionMessages'>, threadId?: Id<'discussionThreads'>) {
		const retained = this.editComposer(id);
		if (retained) return retained;
		const composer = $state<EditComposerState>({
			id: crypto.randomUUID(),
			kind: 'edit',
			messageId: id,
			threadId,
			authorKey: this.viewerKey ?? null,
			account: this.viewerKey ? this.account : null,
			text: '',
			deleteSelectedWording: false,
			open: false,
			busy: false,
			error: null,
			initialized: false,
			expected: 0
		});
		this.work.edits.set(id, composer);
		return composer;
	}
	associateEditComposer(id: Id<'discussionMessages'>, threadId: Id<'discussionThreads'>) {
		const composer = this.work.edits.get(id);
		if (!composer || composer.threadId === threadId) return;
		composer.threadId = threadId;
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
		readonly privateAccess?: { membershipId: Id<'memberships'>; id: Id<'savedContracts'> },
		readonly recovery?: DiscussionRecovery,
		readonly perspective: () => 'buyer' | 'seller' = () => 'buyer'
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
		if (!active) this.cancelAccountPreparation();
		this.activityGeneration++;
		this.recentGeneration++;
		this.stopCreatedSnapshot();
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
			this.selected = null;
			this.closeCreateComposer();
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
				token = await refreshAccount(true);
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
				throw new Error('Reconnect as the original author.');
			this.viewerAccount = Boolean(this.privateAccess || viewer.account);
			this.viewerIdentity = viewer;
			this.bindViewerWork(viewer.key, this.viewerAccount);
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
			this.work.operations.size === 0 &&
			![
				...(this.work.composer ? [this.work.composer] : []),
				...this.work.replies.values(),
				...this.work.edits.values()
			].some((composer) => composer.busy)
		);
	}
	async continueAsBuyer() {
		if (!this.canContinueAsBuyer) return;
		this.resetWork();
		this.selected = null;
		this.viewerEpoch++;
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
		if (this.readOnly) return;
		const composer = this.work.composer;
		if (composer) {
			const sameTarget =
				composer.type === type &&
				composer.revision === this.revision() &&
				composer.contentIdentity === this.contentIdentity() &&
				JSON.stringify(composer.anchor) === JSON.stringify(anchor);
			if (sameTarget && composer.open) {
				composer.open = true;
				this.selected = 'composer';
				void this.loadBuyerViewer();
				return;
			}
			this.closeCreateComposer();
			this.work.composer = null;
		}
		if (!this.work.composer) {
			this.work.composer = {
				id: crypto.randomUUID(),
				kind: 'create',
				authorKey: this.viewerKey ?? null,
				account: this.viewerKey ? this.account : null,
				anchor,
				type,
				revision: this.revision(),
				contentIdentity: this.contentIdentity(),
				text: '',
				open: true,
				busy: false,
				error: null,
				deleteSelectedWording: false
			};
		}
		this.selected = 'composer';
		void this.loadBuyerViewer();
	}
	collapseCreate() {
		if (this.work.composer) {
			this.closeCreateComposer();
			if (this.selected === 'composer') this.selected = null;
		}
	}
	private async write(
		command: Infer<typeof discussionCommand>,
		source: string,
		threadId?: Id<'discussionThreads'>,
		requiredAuthor?: string,
		requiredBuyer = false,
		checkOperationId?: string,
		preparedOperationId?: string
	): Promise<Infer<typeof completedWriteResult> | void> {
		const current = this.captureWriteAccess();
		this.requireWriteAccess(current);
		const retained = this.work.operations.get(source);
		if (checkOperationId && retained?.id !== checkOperationId) return;
		if (
			command.kind !== 'delete' &&
			!checkOperationId &&
			!validDiscussionText(
				command.text,
				(command.kind === 'create' && command.type === 'proposal') ||
					(command.kind === 'edit' &&
						this.threads.some((t) => t.type === 'proposal' && t.root.id === command.messageId))
			)
		)
			throw new Error('Enter a message of 20,000 characters or fewer.');
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
			throw new Error('Reconnect as the original author.');
		if (!this.viewer) throw new Error(this.error ?? 'Reconnect before posting.');
		const owner = this.work;
		let operation = owner.operations.get(source);
		if (checkOperationId && operation?.id !== checkOperationId) return;
		if (!operation && command.kind === 'reply' && this.hasReplyOperation(command.threadId))
			throw new Error('Confirm the pending reply before starting another.');
		if (
			!operation &&
			(command.kind === 'edit' || command.kind === 'delete') &&
			[...owner.operations.values()].some(
				(pending) =>
					(pending.command.kind === 'edit' || pending.command.kind === 'delete') &&
					pending.command.messageId === command.messageId &&
					pending.source !== source
			)
		)
			throw new Error('Confirm the pending change to this message before starting another.');
		if (
			operation &&
			!checkOperationId &&
			!operation.uncertain &&
			!this.receiptPromises.has(operation) &&
			JSON.stringify(command) !== JSON.stringify(operation.command)
		)
			throw new Error('This message is still being confirmed. Check its result first.');
		if (!operation) {
			const created = $state<DiscussionOperation>({
				id: preparedOperationId ?? createOperationId(),
				source,
				authorKey: this.viewer.key,
				account: this.viewerAccount,
				uncertain: false,
				threadId,
				command: structuredClone(command)
			});
			operation = created;
			owner.operations.set(source, operation);
		}
		// The stored copy treats every in-flight request as uncertain after a reload.
		this.persistOperations();
		if (operation.authorKey !== this.viewer.key) {
			this.requiredAuthor = operation.authorKey;
			this.requiredBuyer = !operation.account;
			this.authRequired = true;
			throw new Error('Reconnect as the original author before retrying this message.');
		}
		let checkingReceipt = false;
		try {
			assertOperationRetryable(operation.id);
			if (operation.blocked)
				throw new DiscussionResultUnavailable('This message result is unavailable.');
			if (checkOperationId || operation.uncertain || this.receiptPromises.has(operation)) {
				checkingReceipt = true;
				return await waitForRead(
					this.attachOperation(owner, operation),
					AbortSignal.timeout(15_000)
				);
			}
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
				checkingReceipt = true;
				operation.uncertain = true;
				return await waitForRead(
					this.attachOperation(owner, operation),
					AbortSignal.timeout(15_000)
				);
			}
			this.acceptOperation(owner, operation, result);
			return result;
		} catch (error) {
			const owned = owner.operations.get(source) === operation;
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
			else if (definitive && !checkingReceipt) {
				if (this.work === owner) this.restoreProvisional(source);
				this.settleOperation(owner, operation);
			} else if (owned) {
				operation.uncertain = true;
				this.reconcileOperations();
			}
			if (owner.operations.get(source) === operation) {
				this.operationError(owner, operation, error);
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
		owner: DiscussionWork,
		operation: DiscussionOperation,
		result: Infer<typeof completedWriteResult>
	) {
		if (owner.operations.get(operation.source) !== operation) return;
		if (result.operationId !== operation.id)
			throw new DiscussionResultUnavailable('This message result is unavailable.');
		const command = operation.command;
		if (command.kind === 'create' || command.kind === 'reply') {
			const post = this.provisionalPosts.get(operation.source);
			if (post) {
				this.rememberPostedIdentity(post, result.messageId);
				this.provisionalPosts.set(operation.source, { ...post, messageId: result.messageId });
			}
		}
		if (command.kind === 'create') {
			owner.created.set(operation.id, result.threadId);
			if (owner.composer?.id === operation.source) owner.composer = null;
			if (this.alive && this.work === owner && this.selected === 'composer' && !owner.composer)
				this.selected = result.threadId;
		} else if (command.kind === 'reply') {
			const composer = owner.replies.get(command.threadId);
			if (composer?.id === operation.source) {
				composer.error = null;
				composer.text = '';
				if (this.alive && this.work === owner && this.replyingTo === command.threadId)
					this.replyingTo = null;
			}
		} else if (command.kind === 'edit') {
			const composer = owner.edits.get(command.messageId);
			if (composer?.id === operation.source) {
				composer.error = null;
				composer.initialized = false;
				if (this.alive && this.work === owner && this.editingMessage === command.messageId)
					this.editingMessage = null;
			}
		} else if (command.kind === 'delete') {
			if (command.target === 'thread') {
				this.deletedThreads = new Set([...this.deletedThreads, result.threadId]);
				this.recent = this.recent.filter((thread) => thread.id !== result.threadId);
				if (this.selected === result.threadId) this.selected = null;
			} else this.replies.get(result.threadId)?.hideDeleted(command.messageId);
			const composer = owner.edits.get(command.messageId);
			if (composer) {
				composer.error = null;
				composer.initialized = false;
				if (this.alive && this.work === owner && this.editingMessage === command.messageId)
					this.editingMessage = null;
			}
		}
		this.settleOperation(owner, operation);
		this.reconcileCreateOutcomes();
		if (this.alive && this.work === owner && operation.command.kind === 'reply')
			this.replyState(result.threadId).showCreated(result.messageId);
	}
	private operationError(owner: DiscussionWork, operation: DiscussionOperation, error: unknown) {
		if (operation.blocked && this.work === owner) {
			const command = operation.command;
			if (command.kind === 'create' && owner.composer?.id === operation.source) {
				this.closeCreateComposer();
				if (this.selected === 'composer') this.selected = null;
			} else if (command.kind === 'reply') {
				const composer = owner.replies.get(command.threadId);
				if (composer?.id === operation.source) this.closeReplyComposer(composer);
			} else if (command.kind === 'edit' || command.kind === 'delete') {
				const composer = owner.edits.get(command.messageId);
				if (composer) this.closeEditComposer(composer);
			}
			this.persistOperations();
		}
		const message =
			operation.blocked || isOperationRecovery(error)
				? 'This message result is unavailable. Review the discussion before starting another write.'
				: error instanceof OperationResultFailure
					? saveError(error, 'We couldn’t save this message. Try again.')
					: 'Couldn’t confirm this message. Your original request is still pending; try again to check its result.';
		const command = operation.command;
		const composer =
			command.kind === 'create'
				? owner.composer?.id === operation.source
					? owner.composer
					: undefined
				: command.kind === 'reply'
					? owner.replies.get(command.threadId)?.id === operation.source
						? owner.replies.get(command.threadId)
						: undefined
					: command.kind === 'edit'
						? owner.edits.get(command.messageId)?.id === operation.source
							? owner.edits.get(command.messageId)
							: undefined
						: owner.edits.get(command.messageId);
		if (composer) {
			composer.busy = false;
			composer.error = message;
		}
		if (this.work === owner) this.setProvisionalFailure(operation.source, message);
	}
	private settleOperation(owner: DiscussionWork, operation: DiscussionOperation) {
		this.receipts.get(operation)?.();
		if (owner.operations.get(operation.source) === operation) {
			owner.operations.delete(operation.source);
			if (this.work === owner) this.releaseClosedComposers();
			this.persistOperations();
		}
	}
	private attachOperation(
		owner: DiscussionWork,
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
					throw new DiscussionResultUnavailable('This message result is unavailable.');
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
					let completed: unknown;
					try {
						completed = JSON.parse(value.result);
					} catch {
						throw new DiscussionResultUnavailable('This message result is unavailable.');
					}
					if (!validate(completedResult, completed))
						throw new DiscussionResultUnavailable('This message result is unavailable.');
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
			throw new Error('The discussion view changed. Reopen it and try again.');
		};
		const promise = result()
			.then((value) => {
				if (current() && owner.operations.get(operation.source) === operation)
					this.acceptOperation(owner, operation, value);
				return value;
			})
			.catch((error) => {
				if (
					error instanceof DiscussionResultUnavailable ||
					isOperationRecovery(error) ||
					(error instanceof DiscussionRequestError &&
						['OPERATION_EXPIRED', 'OPERATION_INVALID', 'OPERATION_FUTURE'].includes(
							error.operationCode ?? ''
						))
				)
					operation.blocked = true;
				else if (error instanceof OperationResultFailure) {
					if (this.work === owner) this.restoreProvisional(operation.source);
					this.settleOperation(owner, operation);
				}
				if (
					!lifetime.signal.aborted ||
					operation.blocked ||
					error instanceof OperationResultFailure
				)
					this.operationError(owner, operation, error);
				throw error;
			})
			.finally(stop);
		this.receiptPromises.set(operation, promise);
		return promise;
	}
	reconcileOperations() {
		const pending = new Set(this.work.operations.values());
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
		for (const operation of this.work.operations.values()) {
			if (operation.blocked || !operation.uncertain || this.receipts.has(operation)) continue;
			void this.attachOperation(this.work, operation).catch((error) => {
				if (
					this.alive &&
					this.active &&
					!this.readOnly &&
					!operation.blocked &&
					this.work.operations.get(operation.source) === operation &&
					!this.receipts.has(operation)
				)
					this.viewerError = saveError(
						error,
						'Couldn’t confirm this message. Try again to check the saved result.'
					);
			});
		}
	}
	private submissionError(
		composer: CreateComposerState | ReplyComposerState | EditComposerState,
		source: string,
		error: unknown,
		fallback: string
	) {
		if (this.work.operations.has(source))
			return (
				composer.error ??
				(error instanceof Error &&
				error.message === 'This message is still being confirmed. Check its result first.'
					? error.message
					: 'Couldn’t confirm this message. Your original request is still pending; try again to check its result.')
			);
		return error instanceof Error && error.name !== 'ConvexError'
			? error.message
			: saveError(error, fallback);
	}
	checkableOperationId(source: string) {
		const operation = this.work.operations.get(source);
		return operation &&
			!operation.blocked &&
			(operation.uncertain || this.receiptPromises.has(operation))
			? operation.id
			: undefined;
	}
	hasOperationStatus(source: string) {
		const operation = this.work.operations.get(source);
		return Boolean(operation?.blocked || this.checkableOperationId(source));
	}
	clearBlockedOperation(source: string, operationId: string) {
		const operation = this.work.operations.get(source);
		if (operation?.id !== operationId || !operation.blocked) return;
		this.provisionalPosts.delete(source);
		this.settleOperation(this.work, operation);
	}
	async checkOperation(source: string, operationId: string) {
		const operation = this.work.operations.get(source);
		if (!operation || this.checkableOperationId(source) !== operationId) return;
		try {
			await this.write(
				operation.command,
				operation.source,
				operation.threadId,
				operation.authorKey,
				!operation.account,
				operationId
			);
		} catch {
			// The operation owner records the result for the status shown in the card.
		}
	}
	async submit(checkOperationId?: string) {
		const composer = this.work.composer;
		if (
			this.readOnly ||
			!composer ||
			composer.busy ||
			(checkOperationId && this.checkableOperationId(composer.id) !== checkOperationId) ||
			(!checkOperationId &&
				!(
					validDiscussionText(composer.text) ||
					(composer.type === 'proposal' &&
						composer.deleteSelectedWording &&
						composer.text.length === 0)
				))
		)
			return;
		const submitted = this.snapshotComposer(composer);
		const operationId = checkOperationId ? undefined : createOperationId();
		composer.busy = true;
		composer.error = null;
		if (operationId) {
			this.showProvisional(submitted, operationId, submitted.text);
			composer.open = false;
			this.selected = `pending:${composer.id}`;
		}
		try {
			await this.write(
				createCommand(submitted),
				composer.id,
				undefined,
				composer.authorKey ?? undefined,
				composer.account === false,
				checkOperationId,
				operationId
			);
		} catch (error) {
			if (operationId && !this.work.operations.has(composer.id))
				this.restoreProvisional(composer.id);
			if (this.work.composer === composer)
				composer.error = this.submissionError(
					composer,
					composer.id,
					error,
					'We couldn’t post this message. Try again.'
				);
			if (composer.error) this.setProvisionalFailure(composer.id, composer.error);
		} finally {
			composer.busy = false;
			this.releaseClosedComposers();
		}
	}
	async submitReply(id: Id<'discussionThreads'>, checkOperationId?: string) {
		const composer = this.replyComposer(id);
		if (
			this.readOnly ||
			!composer ||
			composer.busy ||
			(checkOperationId && this.checkableOperationId(composer.id) !== checkOperationId) ||
			(!checkOperationId && !composer.text.trim())
		)
			return;
		const submitted = this.snapshotComposer(composer);
		const operationId = checkOperationId ? undefined : createOperationId();
		composer.busy = true;
		composer.error = null;
		if (operationId) {
			this.showProvisional(submitted, operationId, submitted.text);
			this.replyingTo = null;
		}
		try {
			await this.write(
				{ kind: 'reply', threadId: id, text: submitted.text },
				composer.id,
				id,
				submitted.authorKey ?? undefined,
				submitted.account === false,
				checkOperationId,
				operationId
			);
		} catch (error) {
			if (operationId && !this.work.operations.has(composer.id))
				this.restoreProvisional(composer.id);
			composer.error = this.submissionError(
				composer,
				composer.id,
				error,
				'We couldn’t reply. Try again.'
			);
			if (composer.error) this.setProvisionalFailure(composer.id, composer.error);
		} finally {
			composer.busy = false;
			this.releaseClosedComposers();
		}
	}
	async submitEdit(id: Id<'discussionMessages'>, checkOperationId?: string) {
		const composer = this.editComposer(id);
		if (
			this.readOnly ||
			!composer ||
			composer.busy ||
			(checkOperationId && this.checkableOperationId(composer.id) !== checkOperationId) ||
			(!checkOperationId && !composer.initialized)
		)
			return;
		const submitted = this.snapshotComposer(composer);
		composer.busy = true;
		composer.error = null;
		try {
			await this.write(
				{ kind: 'edit', messageId: id, expectedRevision: submitted.expected, text: submitted.text },
				composer.id,
				composer.threadId,
				submitted.authorKey ?? undefined,
				submitted.account === false,
				checkOperationId
			);
		} catch (error) {
			composer.error = this.submissionError(
				composer,
				composer.id,
				error,
				'We couldn’t save this message. Try again.'
			);
		} finally {
			composer.busy = false;
			this.releaseClosedComposers();
		}
	}
	async deleteMessage(
		message: Infer<typeof discussionMessage>,
		threadId: Id<'discussionThreads'>,
		reply: boolean
	) {
		if (this.readOnly || message.deleted) return;
		const composer = this.ensureEditComposer(message.id, threadId);
		if (composer.busy) return;
		composer.busy = true;
		composer.error = null;
		try {
			await this.write(
				{
					kind: 'delete',
					messageId: message.id,
					expectedRevision: message.revision,
					target: reply ? 'reply' : 'thread'
				},
				`delete:${message.id}`,
				threadId,
				message.author.key,
				!this.account
			);
		} catch (error) {
			const errorMessage = this.submissionError(
				composer,
				`delete:${message.id}`,
				error,
				'We couldn’t delete this message. Try again.'
			);
			composer.error = errorMessage;
			return this.work.operations.has(`delete:${message.id}`) ? undefined : errorMessage;
		} finally {
			composer.busy = false;
			this.releaseClosedComposers();
		}
	}
	destroy() {
		this.setActive(false);
		this.persistOperations();
		this.alive = false;
		if (!this.operationAuthor) this.work.destroy();
		this.feed.destroy();
		for (const state of this.replies.values()) state.destroy();
		this.replies.clear();
		this.replyReferences.clear();
		this.created.clear();
		this.recent = [];
		this.retention.clear();
	}
}
