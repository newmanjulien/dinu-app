<script lang="ts">
	import { tick } from 'svelte';
	import type { Infer } from 'convex/values';
	import type { discussionMessage } from './validators';
	import type { DiscussionSession } from './session.svelte';
	import type { Id } from '../../convex/_generated/dataModel';
	import MessageByline from './MessageByline.svelte';
	import MessageComposer from './MessageComposer.svelte';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import Button from '$lib/ui/Button.svelte';
	import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
	import { observeVisibleMessage } from './visible-message';
	import { composerBoundary } from './focus-composer';
	import type { DeleteConfirmationState } from './delete-confirmation.svelte';
	let {
		message,
		threadId,
		session,
		deletion,
		onActivate,
		onEdit,
		canRead,
		reply = false
	}: {
		message: Infer<typeof discussionMessage>;
		threadId: Id<'discussionThreads'>;
		session: DiscussionSession;
		deletion: DeleteConfirmationState;
		onActivate: (trigger: HTMLButtonElement) => void;
		onEdit: () => void;
		canRead: boolean;
		reply?: boolean;
	} = $props();
	const composer = $derived(session.editComposer(message.id));
	const deleting = $derived(session.isDeleting(message.id));
	let menuOpen = $state(false),
		trigger = $state<HTMLButtonElement>(),
		textElement = $state<HTMLParagraphElement>(),
		confirmationPanel = $state<HTMLDivElement>();
	$effect(() => {
		void session.transitionVersion;
		menuOpen = false;
	});
	const deletionRequest = $derived.by(() => {
		const current = deletion.current;
		return current?.messageId === message.id && !current.abandoned ? current : null;
	});
	const confirmationId = $props.id();
	$effect(() => {
		const messageId = message.id;
		return () => deletion.clearMessage(messageId);
	});
	$effect(() => {
		const element = textElement,
			identity = session.reads.identity;
		const id = message.id,
			revision = message.revision;
		const actorCurrent = session.captureWriteAccess();
		if (!element || !identity || !canRead || !message.author.buyer || !actorCurrent()) return;
		const current = () =>
			actorCurrent() &&
			canRead &&
			session.active &&
			session.authorized &&
			session.reads.identity === identity &&
			message.id === id &&
			message.revision === revision;
		return observeVisibleMessage(element, current, (stillVisible) =>
			session.reads.seen({ messageId: id, revision }, stillVisible)
		);
	});
	const own = $derived(
		!session.readOnly && Boolean(session.viewerKey) && session.viewerKey === message.author.key
	);
	$effect(() => {
		if (
			deletionRequest &&
			!deletionRequest.busy &&
			(message.revision !== deletionRequest.revision || !own)
		)
			deletion.cancel(deletionRequest.token);
	});
	function edit() {
		if (session.readOnly || composer?.busy || deleting) return;
		onEdit();
		session.openEdit(message, threadId);
		menuOpen = false;
	}
	function restoreEditFocus() {
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
	function closeEdit(restoreFocus = false) {
		if (session.editingMessage !== message.id) return;
		session.collapseEdit(message.id);
		if (restoreFocus) restoreEditFocus();
	}
	function requestDelete() {
		if (!own || composer?.busy || deleting) return;
		const token = deletion.open(message.id, message.revision);
		if (token === null) return;
		menuOpen = false;
		void tick().then(() => {
			if (deletion.current?.token === token)
				confirmationPanel?.querySelector('button')?.focus({ preventScroll: true });
		});
	}
	function cancelDelete() {
		const request = deletionRequest;
		if (!request || composer?.busy || deleting || !deletion.cancel(request.token)) return;
		const current = session.captureWriteAccess();
		void tick().then(() => {
			if (current() && !deletion.current && trigger?.isConnected)
				trigger.focus({ preventScroll: true });
		});
	}
	async function confirmDelete() {
		const request = deletionRequest;
		if (!request || request.busy || composer?.busy || deleting) return;
		if (!own || message.revision !== request.revision) {
			deletion.cancel(request.token);
			return;
		}
		if (!deletion.start(request.token)) return;
		const current = session.captureWriteAccess();
		const deletionResult = session.deleteMessage(message, threadId, reply, request.operationId);
		await tick();
		if (current() && deletion.current?.token === request.token && confirmationPanel?.isConnected)
			confirmationPanel.focus({ preventScroll: true });
		const result = await deletionResult;
		if (!current() || deletion.current?.token !== request.token) return;
		if (result.status === 'ignored') {
			deletion.restore(request.token);
			return;
		}
		if (result.status === 'error') {
			deletion.finish(request.token, result.message, result.definite);
			await tick();
			if (current() && deletion.current?.token === request.token)
				confirmationPanel
					?.querySelector<HTMLButtonElement>('button:not(:disabled)')
					?.focus({ preventScroll: true });
		} else {
			deletion.finish(request.token);
			await tick();
			if (current() && !deletion.current && trigger?.isConnected)
				trigger.focus({ preventScroll: true });
		}
	}
</script>

<div
	class={[
		'group first:rounded-t-[inherit] last:rounded-b-[inherit]',
		deletionRequest && !reply ? 'static' : 'relative',
		deletionRequest && 'min-h-28'
	]}
>
	{#if canRead && session.active && session.authorized && !session.readOnly && session.selected === threadId && composer && !deletionRequest}
		<div use:composerBoundary={closeEdit} data-discussion-composer class="p-3.5">
			<MessageComposer
				text={composer.text}
				author={session.viewer}
				viewerKey={session.viewer?.key}
				perspective={session.perspective()}
				title="Edit message"
				placeholder="Write a message…"
					submitLabel={composer.awaitingConfirmation ? 'Retry' : 'Save'}
				closeLabel="Cancel"
				pending={composer.busy}
					textLocked={composer.awaitingConfirmation}
				errorMessage={composer.error ?? ''}
				onTextChange={(value) => session.updateComposerText(value)}
				onClose={() => closeEdit(true)}
				onSubmit={() => session.submitEdit(message.id)}
			/>
		</div>
	{:else}
		<button
			data-discussion-activate
			disabled={Boolean(deletionRequest)}
			class="w-full cursor-pointer appearance-none rounded-[inherit] border-0 bg-transparent p-3.5 pr-11 text-left text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
			type="button"
			onclick={(event) => onActivate(event.currentTarget)}
		>
			<span class="sr-only">{session.readOnly ? 'Read discussion. ' : 'Show reply field. '}</span
			><MessageByline
				author={message.author}
				viewerKey={session.viewerKey}
				perspective={session.perspective()}
			/>
			<p
				bind:this={textElement}
				class="mt-2.5 mb-0 whitespace-pre-wrap text-ink-secondary [overflow-wrap:anywhere]"
			>
				{message.text}
			</p>
		</button>
		{#if own && !deletionRequest}
			<SquareIconButton
				bind:element={trigger}
				type="button"
				class="absolute top-2 right-2 size-[25px] text-ink-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 max-md:opacity-100"
				aria-label={reply ? 'Reply actions' : 'Message actions'}
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				onclick={() => (menuOpen = !menuOpen)}><DotsThreeIcon size={18} /></SquareIconButton
			>
			<Menu
				id={`message-actions-${message.id}`}
				open={menuOpen}
				{trigger}
				onClose={() => (menuOpen = false)}
				label={reply ? 'Reply actions' : 'Message actions'}
			>
				{#snippet children(close)}<MenuItem
						disabled={Boolean(composer?.busy || deleting)}
						onclick={() => {
							close();
							edit();
						}}>Edit</MenuItem
					><MenuItem
						disabled={Boolean(composer?.busy || deleting || deletion.current?.busy)}
						danger
						onclick={() => {
							close();
							requestDelete();
						}}>Delete</MenuItem
					>{/snippet}
			</Menu>
		{/if}
	{/if}
	{#if deletionRequest}
		<div
			bind:this={confirmationPanel}
			data-discussion-delete-confirmation
			role="alertdialog"
			tabindex="-1"
			aria-labelledby={`${confirmationId}-title`}
			class={[
				'absolute inset-0 z-20 flex flex-col justify-center gap-2.5 bg-danger-surface p-3.5 text-ink',
				reply ? 'rounded-[inherit]' : 'items-center rounded-base text-center'
			]}
			onkeydown={(event) => {
				if (event.key === 'Escape') {
					event.stopPropagation();
					cancelDelete();
				} else if (event.key === 'Tab') {
					const buttons = Array.from(confirmationPanel?.querySelectorAll('button') ?? []).filter(
						(button) => !button.disabled
					);
					const first = buttons[0],
						last = buttons.at(-1);
					if (!first || !last) {
						event.preventDefault();
						confirmationPanel?.focus({ preventScroll: true });
					} else if (document.activeElement === confirmationPanel) {
						event.preventDefault();
						(event.shiftKey ? last : first).focus({ preventScroll: true });
					} else if (event.shiftKey && document.activeElement === first) {
						event.preventDefault();
						last?.focus({ preventScroll: true });
					} else if (!event.shiftKey && document.activeElement === last) {
						event.preventDefault();
						first?.focus({ preventScroll: true });
					}
				}
			}}
		>
			<div>
				<p id={`${confirmationId}-title`} class="m-0 text-[13px] font-normal">
					{reply ? 'Delete this reply?' : 'Delete this thread?'}
				</p>
			</div>
			<div class="flex flex-wrap gap-2" aria-busy={deletionRequest.busy}>
				<Button
					disabled={Boolean(deletionRequest.busy || composer?.busy || deleting)}
					class="bg-danger text-white not-disabled:not-aria-disabled:hover:bg-danger-hover"
					onclick={() => void confirmDelete()}
					>{deletionRequest.busy ? 'Deleting…' : 'Delete'}</Button
				>
				<Button
					variant="secondary"
					disabled={Boolean(deletionRequest.busy || composer?.busy || deleting)}
					onclick={cancelDelete}>Cancel</Button
				>
			</div>
			{#if deletionRequest.error}
				<p role="alert" class="m-0 text-xs text-danger">{deletionRequest.error}</p>
			{/if}
		</div>
	{/if}
</div>
