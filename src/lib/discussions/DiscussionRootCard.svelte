<script lang="ts">
	import type { Snippet } from 'svelte';
	import DocumentPanelCard from '$lib/components/document/DocumentPanelCard.svelte';
	import DiscussionMessage from './DiscussionMessage.svelte';
	import { DeleteConfirmationState } from './delete-confirmation.svelte';
	import OperationStatus from './OperationStatus.svelte';
	import type { DiscussionSession, DiscussionThread } from './session.svelte';

	let {
		thread,
		session,
		canRead,
		orphaned = false,
		onActivate,
		recovery,
		detail
	}: {
		thread: DiscussionThread;
		session: DiscussionSession;
		canRead: boolean;
		orphaned?: boolean;
		onActivate: () => void;
		recovery?: Snippet;
		detail?: Snippet<
			[
				HTMLButtonElement | undefined,
				(trigger: HTMLButtonElement) => void,
				DeleteConfirmationState
			]
		>;
	} = $props();
	const deletion = new DeleteConfirmationState();
	const composer = $derived(session.replyComposer(thread.id));
	const pendingOperations = $derived(
		[...session.work.operations.values()].filter(
			(operation) =>
				session.hasOperationStatus(operation.source) &&
				!session.provisionalPosts.has(operation.source) &&
				((operation.command.kind === 'reply' &&
					operation.command.threadId === thread.id &&
					(!composer?.open || composer.id !== operation.source)) ||
					((operation.command.kind === 'edit' || operation.command.kind === 'delete') &&
						operation.command.messageId !== thread.root.id &&
						operation.threadId === thread.id &&
						!(
							session.work.edits.get(operation.command.messageId)?.open &&
							session.work.edits.get(operation.command.messageId)?.id === operation.source
						)))
		)
	);
	let replyTrigger = $state<HTMLButtonElement>();

	function selectThread() {
		onActivate();
		if (!session.readOnly && !session.viewer) void session.loadBuyerViewer();
		session.selected = thread.id;
	}
	function rememberReplyTrigger(trigger: HTMLButtonElement) {
		replyTrigger = trigger;
	}
	function activateReply(trigger: HTMLButtonElement) {
		selectThread();
		if (session.readOnly) return;
		session.editingMessage = null;
		if (!composer?.busy && !session.hasReplyOperation(thread.id)) {
			rememberReplyTrigger(trigger);
			session.replyingTo = thread.id;
		}
	}
</script>

<DocumentPanelCard
	label={thread.type === 'proposal' ? 'Proposed change' : 'Comment'}
	selected={session.selected === thread.id}
>
	{#if !session.readOnly && recovery}<div class="p-3.5">{@render recovery()}</div>{/if}
	{#if orphaned}<p class="px-3.5 pt-3 text-xs text-ink-muted">The selected passage has changed.</p>
		<blockquote class="mx-3.5 mt-2 border-l-2 border-line pl-2 text-xs text-ink-muted">
			{thread.anchor.quote}
		</blockquote>{/if}
	<DiscussionMessage
		message={thread.root}
		threadId={thread.id}
		{session}
		{canRead}
		{deletion}
		onActivate={activateReply}
		onEdit={selectThread}
	/>
	{#if !session.readOnly && pendingOperations.length}
		<div class="grid gap-2 px-3.5 pb-3">
			{#each pendingOperations as operation (operation.id)}
				<OperationStatus
					{session}
					source={operation.source}
					label={operation.command.kind === 'reply' ? 'reply' : 'reply change'}
				/>
			{/each}
		</div>
	{/if}
	{@render detail?.(replyTrigger, rememberReplyTrigger, deletion)}
</DocumentPanelCard>
