<script lang="ts">
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
	let shownReplies = $state(20);
	const replies = $derived(thread.replies.slice(-shownReplies));

	function selectThread() {
		onActivate();
		if (!session.readOnly && !session.viewer) void session.loadViewer();
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

{#if thread.replies.length > shownReplies}
	<div class="px-3.5 pt-2 text-xs">
		<InlineAction onclick={() => (shownReplies += 20)}>Show older replies</InlineAction>
	</div>
{/if}
{#each replies as message (message.id)}
	<DiscussionMessage
		{message}
		threadId={thread.id}
		{session}
		{deletion}
		canRead={canRead && session.authorized}
		reply
		onActivate={activate}
		onEdit={selectThread}
	/>
{/each}
{#if !session.readOnly && session.selected === thread.id && composer}<div class="px-3.5 pb-3.5">
		<ReplyComposer
			id={`reply-${thread.id}`}
			text={composer.text}
			pending={composer.busy}
			textLocked={composer.awaitingConfirmation}
			errorMessage={composer.error ?? ''}
			onTextChange={(value) => session.updateComposerText(value)}
			onClose={closeReply}
			onSubmit={() => session.submitReply(thread.id)}
		/>
	</div>
{/if}
