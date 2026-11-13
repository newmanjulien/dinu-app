<script lang="ts">
	import { tick } from 'svelte';
	import type { Infer } from 'convex/values';
	import type { discussionMessage } from './validators';
	import type { DiscussionSession } from './session.svelte';
	import MessageByline from './MessageByline.svelte';
	import MessageComposer from './MessageComposer.svelte';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
	import { saveError } from '$lib/contract/saved';
	import { observeVisibleMessage } from './visible-message';
	let {
		message,
		session,
		onActivate,
		onEdit,
		canRead,
		reply = false
	}: {
		message: Infer<typeof discussionMessage>;
		session: DiscussionSession;
		onActivate: (trigger: HTMLButtonElement) => void;
		onEdit: () => void;
		canRead: boolean;
		reply?: boolean;
	} = $props();
	const draft = $derived(session.editDraft(message.id));
	let menuOpen = $state(false),
		trigger = $state<HTMLButtonElement>(),
		editorElement = $state<HTMLDivElement>(),
		textElement = $state<HTMLParagraphElement>();
	$effect(() => {
		const element = textElement,
			identity = session.reads.identity;
		const id = message.id,
			revision = message.revision;
		if (!element || !identity || !canRead || !message.author.buyer || message.deleted) return;
		const current = () =>
			canRead &&
			session.active &&
			session.feed.authorized &&
			session.feed.firstPageAccepted &&
			session.reads.identity === identity &&
			message.id === id &&
			message.revision === revision &&
			!message.deleted;
		return observeVisibleMessage(element, current, (stillVisible) =>
			session.reads.seen({ messageId: id, revision }, stillVisible)
		);
	});
	const own = $derived(!session.readOnly && session.viewerKey === message.author.key);
	function edit() {
		if (session.readOnly || draft.busy) return;
		onEdit();
		if (!draft.initialized) {
			draft.text = message.text;
			draft.expected = message.revision;
			draft.authorKey = message.author.key;
			draft.account = session.account;
			draft.error = null;
			draft.initialized = true;
		}
		session.replyingTo = null;
		session.editingMessage = message.id;
		menuOpen = false;
	}
	function closeEdit(restoreFocus = false) {
		if (session.editingMessage !== message.id) return;
		session.editingMessage = null;
		if (restoreFocus) {
			const selected = session.selected;
			const current = session.captureWriteAccess();
			void tick().then(() => {
				if (
					current() &&
					session.selected === selected &&
					!session.editingMessage &&
					!session.replyingTo &&
					trigger?.isConnected
				)
					trigger.focus({ preventScroll: true });
			});
		}
	}
	function cancelEdit() {
		if (draft.busy) return;
		draft.initialized = false;
		draft.error = null;
		closeEdit(true);
	}
	function handleFocusOut(event: FocusEvent) {
		if (!draft.busy && !editorElement?.contains(event.relatedTarget as Node | null)) closeEdit();
	}
	async function commit(remove = false) {
		if (session.readOnly || draft.busy) return;
		const current = session.captureWriteAccess();
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
				remove ? !session.account : !draft.account
			);
			draft.initialized = false;
			if (current()) closeEdit();
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
	{#if !session.readOnly && session.editingMessage === message.id}
		<div
			bind:this={editorElement}
			data-discussion-composer
			class={reply ? 'p-3.5 pl-5' : 'p-3.5'}
			onfocusout={handleFocusOut}
		>
			<MessageComposer
				allowDeletion={!reply &&
					session.threads.some((t) => t.type === 'proposal' && t.root.id === message.id)}
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
				onCancel={cancelEdit}
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
			onclick={(event) => onActivate(event.currentTarget)}
		>
			<span class="sr-only">{session.readOnly ? 'Read discussion. ' : 'Show reply field. '}</span
			><MessageByline author={message.author} viewerKey={session.viewerKey} />
			<p
				bind:this={textElement}
				class="mt-2.5 mb-0 whitespace-pre-wrap text-ink-secondary [overflow-wrap:anywhere]"
			>
				{message.deleted ? 'Message deleted' : message.text || 'Delete selected wording'}
			</p>
		</button>
		{#if own && !message.deleted}
			<SquareIconButton
				bind:element={trigger}
				type="button"
				class="absolute top-2 right-2 size-7 text-ink-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
				aria-label="Message actions"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				onclick={() => (menuOpen = !menuOpen)}><DotsThreeIcon size={20} /></SquareIconButton
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
						danger
						onclick={() => {
							close();
							void commit(true);
						}}>Delete</MenuItem
					>{/snippet}
			</Menu>
		{/if}
	{/if}
	{#if !session.readOnly && draft.error && session.editingMessage !== message.id}<p
			role="alert"
			class="px-3.5 pb-3.5 text-xs text-danger"
		>
			{draft.error}
		</p>{/if}
</div>
