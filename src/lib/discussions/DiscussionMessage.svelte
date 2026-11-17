<script lang="ts">
	import { tick } from 'svelte';
	import type { Infer } from 'convex/values';
	import type { discussionMessage } from './validators';
	import type { DiscussionSession } from './session.svelte';
	import type { Id } from '../../convex/_generated/dataModel';
	import MessageByline from './MessageByline.svelte';
	import MessageComposer from './MessageComposer.svelte';
	import OperationStatus from './OperationStatus.svelte';
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
	const pendingSource = $derived(
		[...session.work.operations.values()].find(
			(operation) =>
				(operation.command.kind === 'edit' || operation.command.kind === 'delete') &&
				operation.command.messageId === message.id
		)?.source ?? null
	);
	$effect(() => {
		if (pendingSource && composer && composer.threadId !== threadId)
			session.associateEditComposer(message.id, threadId);
	});
	let menuOpen = $state(false),
		trigger = $state<HTMLButtonElement>(),
		textElement = $state<HTMLParagraphElement>(),
		confirmationPanel = $state<HTMLDivElement>();
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
	const own = $derived(
		!session.readOnly && Boolean(session.viewerKey) && session.viewerKey === message.author.key
	);
	$effect(() => {
		if (
			deletionRequest &&
			!deletionRequest.busy &&
			(message.deleted || message.revision !== deletionRequest.revision || !own)
		)
			deletion.cancel(deletionRequest.token);
	});
	function edit() {
		if (session.readOnly || composer?.busy || pendingSource) return;
		onEdit();
		const editComposer = session.ensureEditComposer(message.id, threadId);
		if (!editComposer.initialized) {
			editComposer.text = message.text;
			editComposer.deleteSelectedWording = false;
			editComposer.expected = message.revision;
			editComposer.authorKey = message.author.key;
			editComposer.account = session.account;
			editComposer.error = null;
			editComposer.initialized = true;
		}
		session.associateEditComposer(message.id, threadId);
		session.replyingTo = null;
		session.editingMessage = message.id;
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
		if (!own || message.deleted || composer?.busy || pendingSource) return;
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
		if (!request || composer?.busy || !deletion.cancel(request.token)) return;
		void tick().then(() => {
			if (!deletion.current && trigger?.isConnected) trigger.focus({ preventScroll: true });
		});
	}
	async function confirmDelete() {
		const request = deletionRequest;
		if (!request || request.busy || composer?.busy || pendingSource) return;
		if (!own || message.deleted || message.revision !== request.revision) {
			deletion.cancel(request.token);
			return;
		}
		if (!deletion.start(request.token)) return;
		const deletionResult = session.deleteMessage(message, threadId, reply);
		await tick();
		if (deletion.current?.token === request.token && confirmationPanel?.isConnected)
			confirmationPanel.focus({ preventScroll: true });
		const error = await deletionResult;
		if (deletion.current?.token !== request.token) return;
		deletion.finish(request.token, error);
		if (error) {
			await tick();
			if (deletion.current?.token === request.token)
				confirmationPanel
					?.querySelector<HTMLButtonElement>('button:not(:disabled)')
					?.focus({ preventScroll: true });
		} else {
			await tick();
			if (!deletion.current && trigger?.isConnected) trigger.focus({ preventScroll: true });
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
	{#if canRead && session.active && session.feed.authorized && session.feed.firstPageAccepted && !session.readOnly && session.selected === threadId && session.editingMessage === message.id && composer && !deletionRequest}
		<div use:composerBoundary={closeEdit} data-discussion-composer class="p-3.5">
			<MessageComposer
				allowDeletion={!reply &&
					session.threads.some((t) => t.type === 'proposal' && t.root.id === message.id)}
				deleting={composer.deleteSelectedWording}
				text={composer.text}
				author={session.viewer}
				viewerKey={session.viewer?.key}
				perspective={session.perspective()}
				title="Edit message"
				placeholder="Write a message…"
				submitLabel="Save"
				closeLabel="Cancel"
				pending={composer.busy}
				checkResultId={session.checkableOperationId(composer.id)}
				writeBlocked={Boolean(pendingSource && pendingSource !== composer.id)}
				errorMessage={composer.error ?? ''}
				onTextChange={(value) => session.work.setText(composer, value)}
				onDeleteChange={(deleting) => session.work.setDeletion(composer, deleting)}
				onClose={() => closeEdit(true)}
				onSubmit={() => session.submitEdit(message.id)}
				onCheckResult={(operationId) => session.submitEdit(message.id, operationId)}
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
				{message.deleted ? 'Message deleted' : message.text || 'Delete selected wording'}
			</p>
		</button>
		{#if own && !message.deleted && !deletionRequest}
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
						disabled={Boolean(composer?.busy || pendingSource)}
						onclick={() => {
							close();
							edit();
						}}>Edit</MenuItem
					><MenuItem
						disabled={Boolean(composer?.busy || pendingSource || deletion.current?.busy)}
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
					disabled={Boolean(deletionRequest.busy || composer?.busy || pendingSource)}
					class="bg-danger text-white not-disabled:not-aria-disabled:hover:bg-danger-hover"
					onclick={() => void confirmDelete()}
					>{deletionRequest.busy ? 'Deleting…' : 'Delete'}</Button
				>
				<Button
					variant="secondary"
					disabled={Boolean(deletionRequest.busy || composer?.busy)}
					onclick={cancelDelete}>Cancel</Button
				>
			</div>
			{#if deletionRequest.error}
				<p role="alert" class="m-0 text-xs text-danger">{deletionRequest.error}</p>
			{/if}
		</div>
	{/if}
	{#if !session.readOnly && !reply && !composer?.open && pendingSource && session.hasOperationStatus(pendingSource)}
		<div class="px-3.5 pb-3.5">
			<OperationStatus {session} source={pendingSource} label="message change" />
		</div>
	{/if}
</div>
