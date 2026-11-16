<script lang="ts">
	import { onDestroy, untrack, type Snippet } from 'svelte';
	import PlaybookCard from '$lib/components/playbook/PlaybookCard.svelte';
	import InlineAction from '$lib/components/playbook/InlineAction.svelte';
	import type { DiscussionThread, DiscussionSession } from './session.svelte';
	import DiscussionMessage from './DiscussionMessage.svelte';
	import ReplyComposer from './ReplyComposer.svelte';
	import { saveError } from '$lib/contract/saved';
	let {
		thread,
		session,
		canRead,
		orphaned = false,
		onActivate,
		header,
		recovery
	}: {
		thread: DiscussionThread;
		session: DiscussionSession;
		canRead: boolean;
		orphaned?: boolean;
		onActivate: () => void;
		header?: Snippet;
		recovery?: Snippet;
	} = $props();
	const draft = $derived(session.replyDraft(thread.id));
	let replyTrigger: HTMLButtonElement | undefined;
	const replyLease = untrack(() => session.acquireReplies(thread.id));
	const replies = replyLease.state;
	onDestroy(replyLease.release);
	const feed = replies.feed;
	$effect(() => {
		const active = session.active && session.feed.authorized && session.feed.firstPageAccepted;
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
		if (!draft.busy) {
			replyTrigger = trigger;
			session.replyingTo = thread.id;
		}
	}
	function closeReply(restoreFocus = false) {
		if (session.replyingTo !== thread.id) return;
		session.replyingTo = null;
		if (restoreFocus && replyTrigger?.isConnected) replyTrigger.focus({ preventScroll: true });
	}
	async function submit() {
		if (session.readOnly || draft.busy || !draft.text.trim()) return;
		const current = session.captureWriteAccess();
		draft.busy = true;
		draft.error = null;
		const submitted = draft.text;
		try {
			await session.write({ kind: 'reply', threadId: thread.id, text: submitted });
			if (draft.text === submitted) draft.text = '';
			if (current()) closeReply();
		} catch (e) {
			draft.error =
				e instanceof Error && e.name !== 'ConvexError'
					? e.message
					: saveError(e, 'We couldn’t reply. Your draft is still here.');
		} finally {
			draft.busy = false;
		}
	}
</script>

<PlaybookCard
	label={thread.type === 'proposal' ? 'Proposed change' : 'Comment'}
	variant="discussion"
>
	{@render header?.()}
	{#if !session.readOnly && recovery}<div class="p-3.5">{@render recovery()}</div>{/if}
	{#if orphaned}<p class="px-3.5 pt-3 text-xs text-ink-muted">The selected passage has changed.</p>
		<blockquote class="mx-3.5 mt-2 border-l-2 border-line pl-2 text-xs text-ink-muted">
			{thread.anchor.quote}
		</blockquote>{/if}
	<DiscussionMessage
		message={thread.root}
		{session}
		{canRead}
		onActivate={activate}
		onEdit={selectThread}
	/>
	{#each replies.rows as message (message.id)}<DiscussionMessage
			{message}
			{session}
			canRead={canRead && feed.authorized && feed.firstPageAccepted}
			reply
			onActivate={activate}
			onEdit={selectThread}
		/>{/each}
	{#if !feed.done}<div class="px-3.5 pb-3 text-xs">
			<InlineAction
				disabled={feed.loading}
				onclick={() => (feed.error || !feed.authorized ? replies.retry() : feed.loadMore())}
				>{feed.loading ? 'Loading replies…' : 'More replies'}</InlineAction
			>
		</div>{/if}
	{#if !session.readOnly && session.replyingTo === thread.id}<div class="px-3.5 pb-3.5">
			<ReplyComposer
				id={`reply-${thread.id}`}
				text={draft.text}
				pending={draft.busy}
				errorMessage={draft.error ?? feed.error?.message ?? ''}
				onTextChange={(value) => (draft.text = value)}
				onCancel={closeReply}
				onSubmit={() => void submit()}
			/>
		</div>
	{:else if (!session.readOnly && draft.error) || feed.error}<p
			role="alert"
			class="px-3.5 pb-3 text-xs text-danger"
		>
			{(!session.readOnly && draft.error) || feed.error?.message}
		</p>{/if}
</PlaybookCard>
