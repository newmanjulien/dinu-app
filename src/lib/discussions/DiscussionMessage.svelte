<script lang="ts">
	import type { Infer } from 'convex/values';
	import type { discussionMessage } from './validators';
	import type { DiscussionSession } from './session.svelte';
	import MessageByline from './MessageByline.svelte';
	import MessageComposer from './MessageComposer.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
	import { saveError } from '$lib/contract/saved';
	let {
		message,
		session,
		onActivate,
		reply = false
	}: {
		message: Infer<typeof discussionMessage>;
		session: DiscussionSession;
		onActivate: () => void;
		reply?: boolean;
	} = $props();
	const draft = $derived(session.editDraft(message.id));
	let menuOpen = $state(false),
		trigger = $state<HTMLButtonElement>();
	const own = $derived(session.viewer?.key === message.author.key);
	function edit() {
		if (!draft.open) {
			draft.text = message.text;
			draft.expected = message.revision;
			draft.authorKey = message.author.key;
		}
		draft.open = true;
		draft.error = null;
		menuOpen = false;
	}
	async function commit(remove = false) {
		if (draft.busy) return;
		draft.busy = true;
		draft.error = null;
		try {
			await session.write(
				remove
					? { kind: 'delete', messageId: message.id, expectedRevision: message.revision }
					: {
							kind: 'edit',
							messageId: message.id,
							expectedRevision: draft.expected,
							text: draft.text
						},
				remove ? message.author.key : draft.authorKey,
				message.author.buyer
			);
			draft.open = false;
		} catch (e) {
			draft.error =
				e instanceof Error && e.name !== 'ConvexError'
					? e.message
					: saveError(e, 'We couldn’t save this message. Your draft is still here.');
		} finally {
			draft.busy = false;
		}
	}
</script>

<div class="group relative first:rounded-t-[inherit] last:rounded-b-[inherit]">
	{#if draft.open}
		<div class={reply ? 'p-3.5 pl-5' : 'p-3.5'}>
			<MessageComposer
				text={draft.text}
				author={session.viewer}
				viewerKey={session.viewer?.key}
				title="Edit message"
				placeholder="Write a message…"
				submitLabel="Save"
				cancelLabel="Cancel"
				pending={draft.busy}
				errorMessage={draft.error ?? ''}
				onTextChange={(value) => (draft.text = value)}
				onCancel={() => {
					if (!draft.busy) {
						draft.open = false;
						draft.error = null;
					}
				}}
				onSubmit={() => void commit()}
			/>
		</div>
	{:else}
		<button
			class={[
				'w-full cursor-pointer appearance-none rounded-[inherit] border-0 bg-transparent p-3.5 pr-11 text-left text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
				reply && 'pl-5'
			]}
			type="button"
			onclick={onActivate}
		>
			<span class="sr-only">Show reply field. </span><MessageByline
				author={message.author}
				viewerKey={session.viewer?.key}
			/>
			<p
				class="mt-2.5 mb-0 text-[15px] leading-[1.5] whitespace-pre-wrap text-ink-secondary [overflow-wrap:anywhere]"
			>
				{message.deleted ? 'Message deleted' : message.text}
			</p>
		</button>
		{#if own && !message.deleted}
			<button
				bind:this={trigger}
				type="button"
				class="absolute top-2 right-2 flex size-7 cursor-pointer items-center justify-center rounded-button-sm text-ink-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
				aria-label="Message actions"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				onclick={() => (menuOpen = !menuOpen)}><DotsThreeIcon size={20} /></button
			>
			<Menu
				id={`message-actions-${message.id}`}
				open={menuOpen}
				{trigger}
				onClose={() => (menuOpen = false)}
				label="Message actions"
			>
				{#snippet children(close)}<MenuItem
						onclick={() => {
							close();
							edit();
						}}>Edit</MenuItem
					><MenuItem
						onclick={() => {
							close();
							void commit(true);
						}}>Delete</MenuItem
					>{/snippet}
			</Menu>
		{/if}
	{/if}
	{#if draft.error && !draft.open}<p role="alert" class="px-3.5 pb-3.5 text-xs text-ink-secondary">
			{draft.error}
		</p>{/if}
</div>
