<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import InlineAction from '$lib/components/playbook/InlineAction.svelte';
	import type { DiscussionThread, DiscussionSession } from './session.svelte';
	import DiscussionMessage from './DiscussionMessage.svelte';
	import ReplyComposer from './ReplyComposer.svelte';
	import type { DeleteConfirmationState } from './delete-confirmation.svelte';
	let {
		thread,
		session,
		canRead,
		onActivate,
		replyTrigger,
		onReplyTrigger,
		deletion
	}: {
		thread: DiscussionThread;
		session: DiscussionSession;
		canRead: boolean;
		onActivate: () => void;
		replyTrigger?: HTMLButtonElement;
		onReplyTrigger: (trigger: HTMLButtonElement) => void;
		deletion: DeleteConfirmationState;
	} = $props();
	const composer = $derived(session.replyComposer(thread.id));
	const replyLease = untrack(() => session.acquireReplies(thread.id));
	const replies = replyLease.state;
	onDestroy(replyLease.release);
	$effect(() => {
		const active = canRead && session.active && session.authorized;
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
		if (!composer?.busy) {
			onReplyTrigger(trigger);
			session.openReply(thread.id);
		}
	}
	function closeReply(restoreFocus = false) {
		if (session.replyingTo !== thread.id) return;
		session.collapseReply(thread.id);
		if (restoreFocus && replyTrigger?.isConnected) replyTrigger.focus({ preventScroll: true });
	}
</script>

{#each replies.rows as message (message.id)}
	<DiscussionMessage
		{message}
		threadId={thread.id}
		{session}
		{deletion}
		canRead={canRead && replies.authorized}
		reply
		onActivate={activate}
		onEdit={selectThread}
	/>
{/each}
{#if replies.error}<div class="px-3.5 pb-3 text-xs">
		<InlineAction onclick={() => replies.retry()}>Retry replies</InlineAction>
	</div>{/if}
{#if !session.readOnly && session.selected === thread.id && composer}<div class="px-3.5 pb-3.5">
		<ReplyComposer
			id={`reply-${thread.id}`}
			text={composer.text}
			pending={composer.busy}
			textLocked={composer.awaitingConfirmation}
			errorMessage={composer.error ?? replies.error ?? ''}
			onTextChange={(value) => session.updateComposerText(value)}
			onClose={closeReply}
			onSubmit={() => session.submitReply(thread.id)}
		/>
	</div>
{:else if replies.error}<p role="alert" class="px-3.5 pb-3 text-xs text-danger">
		{replies.error}
	</p>{/if}
