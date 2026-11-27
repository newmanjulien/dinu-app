<script lang="ts">
	import type { Snippet } from 'svelte';
	import DocumentPanelCard from '$lib/components/document/DocumentPanelCard.svelte';
	import DiscussionMessage from './DiscussionMessage.svelte';
	import { DeleteConfirmationState } from './delete-confirmation.svelte';
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
			[HTMLButtonElement | undefined, (trigger: HTMLButtonElement) => void, DeleteConfirmationState]
		>;
	} = $props();
	const deletion = new DeleteConfirmationState();
	const composer = $derived(session.replyComposer(thread.id));
	let replyTrigger = $state<HTMLButtonElement>();
	$effect(() => {
		void session.policyVersion;
		return () => deletion.clear();
	});

	function selectThread() {
		onActivate();
		if (!session.readOnly && !session.viewer) void session.loadViewer();
		session.selected = thread.id;
	}
	function rememberReplyTrigger(trigger: HTMLButtonElement) {
		replyTrigger = trigger;
	}
	function activateReply(trigger: HTMLButtonElement) {
		selectThread();
		if (session.readOnly) return;
		if (!composer?.busy) {
			rememberReplyTrigger(trigger);
			session.openReply(thread.id);
		}
	}
</script>

<DocumentPanelCard label="Comment" selected={session.selected === thread.id}>
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
	{@render detail?.(replyTrigger, rememberReplyTrigger, deletion)}
</DocumentPanelCard>
