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
	let {
		message,
		threadId,
		session,
		onActivate,
		onEdit,
		canRead,
		reply = false
	}: {
		message: Infer<typeof discussionMessage>;
		threadId: Id<'discussionThreads'>;
		session: DiscussionSession;
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
		confirmationPanel = $state<HTMLDivElement>(),
		deletionRequest = $state<{ revision: number; error: string | null } | null>(null);
	const confirmationId = $props.id();
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
		if (deletionRequest && (message.deleted || message.revision !== deletionRequest.revision || !own))
			deletionRequest = null;
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
		menuOpen = false;
		deletionRequest = { revision: message.revision, error: null };
		void tick().then(() => confirmationPanel?.querySelector('button')?.focus({ preventScroll: true }));
	}
	function cancelDelete() {
		if (composer?.busy) return;
		deletionRequest = null;
		void tick().then(() => {
			if (trigger?.isConnected) trigger.focus({ preventScroll: true });
		});
	}
	async function confirmDelete() {
		const request = deletionRequest;
		if (!request || composer?.busy || pendingSource) return;
		if (!own || message.deleted || message.revision !== request.revision) {
			deletionRequest = { ...request, error: 'This message changed. Close and try again.' };
			return;
		}
		const deletion = session.deleteMessage(message, threadId, reply);
		await tick();
		if (deletionRequest === request && composer?.busy && confirmationPanel?.isConnected)
			confirmationPanel.focus({ preventScroll: true });
		const error = await deletion;
		if (deletionRequest !== request) return;
		if (error) {
			deletionRequest = { ...request, error };
			await tick();
			confirmationPanel
				?.querySelector<HTMLButtonElement>('button:not(:disabled)')
				?.focus({ preventScroll: true });
		} else {
			deletionRequest = null;
			await tick();
			if (trigger?.isConnected) trigger.focus({ preventScroll: true });
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
		<div
			use:composerBoundary={closeEdit}
			data-discussion-composer
			class="p-3.5"
		>
			<MessageComposer
				allowDeletion={!reply &&
					session.threads.some((t) => t.type === 'proposal' && t.root.id === message.id)}
				deleting={composer.deleteSelectedWording}
				text={composer.text}
				author={session.viewer}
				viewerKey={session.viewer?.key}
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
			><MessageByline author={message.author} viewerKey={session.viewerKey} />
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
				class={`absolute top-2 right-2 size-[25px] text-ink-muted ${reply
					? 'opacity-100'
					: 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 max-md:opacity-100'}`}
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
						disabled={Boolean(composer?.busy || pendingSource)}
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
			aria-describedby={`${confirmationId}-description`}
			class={[
				'absolute inset-0 z-20 flex flex-col justify-center gap-2.5 p-3.5 text-surface',
				reply ? 'rounded-[inherit] bg-ink/90' : 'items-center rounded-base bg-ink/80 text-center'
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
				<p id={`${confirmationId}-title`} class="m-0 text-sm font-medium">
					{reply ? 'Delete this reply?' : 'Delete this thread?'}
				</p>
				<p id={`${confirmationId}-description`} class="mt-0.5 mb-0 text-xs text-surface/85">
					{reply
						? 'Only this reply will be removed.'
						: 'This removes the entire thread and its document highlight.'}
				</p>
			</div>
			<div class="flex flex-wrap gap-2" aria-busy={Boolean(composer?.busy)}>
				<Button
					disabled={Boolean(composer?.busy || pendingSource)}
					class="bg-danger text-white not-disabled:not-aria-disabled:hover:bg-danger-hover"
					onclick={() => void confirmDelete()}
				>{composer?.busy ? 'Deleting…' : 'Delete'}</Button
				>
				<Button variant="secondary" disabled={Boolean(composer?.busy)} onclick={cancelDelete}
					>Cancel</Button
				>
			</div>
			{#if deletionRequest.error}
				<p role="alert" class="m-0 text-xs text-surface">{deletionRequest.error}</p>
			{/if}
		</div>
	{/if}
	{#if !session.readOnly && !reply && !composer?.open && pendingSource && session.hasOperationStatus(pendingSource)}
		<div class="px-3.5 pb-3.5">
			<OperationStatus {session} source={pendingSource} label="message change" />
		</div>
	{/if}
</div>
