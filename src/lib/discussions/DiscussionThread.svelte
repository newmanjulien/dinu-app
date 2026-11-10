<script lang="ts">
	import { untrack } from 'svelte';
	import type { DiscussionThread, DiscussionSession } from './session.svelte';
	import DiscussionMessage from './DiscussionMessage.svelte';
	import ReplyComposer from './ReplyComposer.svelte';
	import { saveError } from '$lib/contract/saved';
	let {
		thread,
		session,
		orphaned = false
	}: { thread: DiscussionThread; session: DiscussionSession; orphaned?: boolean } = $props();
	const draft = $derived(session.replyDraft(thread.id));
	let applying = $state(false);
	const replies = untrack(() => session.replyState(thread.id));
	const feed = replies.feed;
	$effect(() => {
		replies.setActive(session.active);
		return () => replies.setActive(false);
	});

	function activate() {
		if (!session.viewer) void session.loadBuyerViewer();
		session.selected = thread.id;
		draft.open = true;
	}
	async function submit() {
		if (draft.busy || !draft.text.trim()) return;
		draft.busy = true;
		draft.error = null;
		const submitted = draft.text;
		try {
			await session.write({ kind: 'reply', threadId: thread.id, text: draft.text });
			if (draft.text === submitted) draft.text = '';
		} catch (e) {
			draft.error =
				e instanceof Error && e.name !== 'ConvexError'
					? e.message
					: saveError(e, 'We couldn’t reply. Your draft is still here.');
		} finally {
			draft.busy = false;
		}
	}
	async function apply() {
		if (applying || !session.onApply) return;
		applying = true;
		draft.error = null;
		try {
			await session.onApply(thread);
		} catch (e) {
			draft.error = saveError(
				e,
				'We couldn’t apply this proposal. Review the current wording and try again.'
			);
		} finally {
			applying = false;
		}
	}
</script>

<div
	class="w-full overflow-visible rounded-[9px] border border-line bg-surface text-ink shadow-none"
	data-context-panel
>
	{#if orphaned}<p class="px-3.5 pt-3 text-xs text-ink-muted">The selected passage has changed.</p>
		<blockquote class="mx-3.5 mt-2 border-l-2 border-line pl-2 text-xs text-ink-muted">
			{thread.anchor.quote}
		</blockquote>{/if}
	<DiscussionMessage message={thread.root} {session} onActivate={activate} />
	{#if thread.type === 'proposal' && !thread.root.deleted}
		<div class="px-3.5 pb-3 text-xs text-ink-secondary">
			{#if thread.applied}Applied as a contract concession.{:else if session.onApply}<button
					class="cursor-pointer underline disabled:cursor-default"
					disabled={applying}
					onclick={() => void apply()}>{applying ? 'Applying…' : 'Apply proposed wording'}</button
				>{:else}Proposed wording{/if}
		</div>
	{/if}
	{#each replies.rows as message (message.id)}<DiscussionMessage
			{message}
			{session}
			reply
			onActivate={activate}
		/>{/each}
	{#if !feed.done}<button
			class="mx-3.5 mb-3 cursor-pointer text-xs text-ink-muted underline"
			disabled={feed.loading}
			onclick={() => (feed.error || !feed.authorized ? replies.retry() : feed.loadMore())}
			>{feed.loading ? 'Loading replies…' : 'More replies'}</button
		>{/if}
	{#if draft.open}<div class="p-3.5">
			<ReplyComposer
				id={`reply-${thread.id}`}
				text={draft.text}
				pending={draft.busy}
				errorMessage={draft.error ?? feed.error?.message ?? ''}
				onTextChange={(value) => (draft.text = value)}
				onCancel={() => {
					if (!draft.busy) draft.open = false;
				}}
				onSubmit={() => void submit()}
			/>
		</div>
	{:else if draft.error || feed.error}<p
			role="alert"
			class="px-3.5 pb-3 text-xs text-ink-secondary"
		>
			{draft.error ?? feed.error?.message}
		</p>{/if}
</div>
