<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import InlineAction from '$lib/components/playbook/InlineAction.svelte';
	import type { DiscussionThread, DiscussionSession } from './session.svelte';
	import DiscussionMessage from './DiscussionMessage.svelte';
	import ProvisionalMessage from './ProvisionalMessage.svelte';
	import ReplyComposer from './ReplyComposer.svelte';
	let {
		thread,
		session,
		canRead,
		onActivate,
		replyTrigger,
		onReplyTrigger
	}: {
		thread: DiscussionThread;
		session: DiscussionSession;
		canRead: boolean;
		onActivate: () => void;
		replyTrigger?: HTMLButtonElement;
		onReplyTrigger: (trigger: HTMLButtonElement) => void;
	} = $props();
	const composer = $derived(session.replyComposer(thread.id));
	const replyLease = untrack(() => session.acquireReplies(thread.id));
	const replies = replyLease.state;
	onDestroy(replyLease.release);
	const feed = replies.feed;
	const displayedReplies = $derived(session.displayReplies(thread.id, replies.rows));
	$effect(() => {
		const rows = replies.rows;
		const pending = session.provisionalReplies(thread.id);
		if (!pending.length) return;
		untrack(() => session.reconcileProvisionalReplies(thread.id, rows));
	});
	$effect(() => {
		const active =
			canRead && session.active && session.feed.authorized && session.feed.firstPageAccepted;
		untrack(() => replies.setActive(active));
		return () => replies.setActive(false);
	});

	function selectThread() {
		onActivate();
		if (!session.readOnly && !session.viewer) void session.loadBuyerViewer();
		session.selected = thread.id;
	}
	function activate(trigger: HTMLButtonElement) {
		selectThread();
		if (session.readOnly) return;
		session.editingMessage = null;
		if (!composer?.busy && !session.hasReplyOperation(thread.id)) {
			onReplyTrigger(trigger);
			session.replyingTo = thread.id;
		}
	}
	function closeReply(restoreFocus = false) {
		if (session.replyingTo !== thread.id) return;
		session.collapseReply(thread.id);
		if (restoreFocus && replyTrigger?.isConnected) replyTrigger.focus({ preventScroll: true });
	}
</script>

{#each displayedReplies as row (row.key)}
	{#if row.kind === 'saved'}
		<DiscussionMessage
			message={row.saved}
			threadId={thread.id}
			{session}
			canRead={canRead && feed.authorized && feed.firstPageAccepted}
			reply
			onActivate={activate}
			onEdit={selectThread}
		/>
	{:else}
		<ProvisionalMessage post={row.post} {session} />
	{/if}
{/each}
{#if feed.error}<div class="px-3.5 pb-3 text-xs">
		<InlineAction onclick={() => replies.retry()}>Retry replies</InlineAction>
	</div>{/if}
{#if !session.readOnly && session.selected === thread.id && session.replyingTo === thread.id && composer}<div
		class="px-3.5 pb-3.5"
	>
		<ReplyComposer
			id={`reply-${thread.id}`}
			text={composer.text}
			pending={composer.busy}
			checkResultId={session.checkableOperationId(composer.id)}
			errorMessage={composer.error ?? feed.error?.message ?? ''}
			onTextChange={(value) => session.updatePostText(composer, value)}
			onClose={closeReply}
			onSubmit={() => session.submitReply(thread.id)}
			onCheckResult={(operationId) => session.submitReply(thread.id, operationId)}
		/>
	</div>
{:else if feed.error}<p role="alert" class="px-3.5 pb-3 text-xs text-danger">
		{feed.error.message}
	</p>{/if}
