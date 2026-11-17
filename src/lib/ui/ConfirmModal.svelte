<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from './Button.svelte';
	import ModalShell from './ModalShell.svelte';

	type Props = {
		open?: boolean;
		portal?: boolean;
		title: string;
		message: string;
		confirmLabel?: string;
		confirmDisabled?: boolean;
		cancelLabel?: string;
		pendingLabel?: string;
		destructive?: boolean;
		secondaryActionLabel?: string;
		secondaryPendingLabel?: string;
		secondaryDestructive?: boolean;
		busy?: boolean;
		error?: string | null;
		onConfirm: () => void | Promise<void>;
		onSecondaryAction?: () => void | Promise<void>;
		onCancel: () => void;
		children?: Snippet;
	};

	let {
		open = true,
		portal = false,
		title,
		message,
		confirmLabel = 'Confirm',
		confirmDisabled = false,
		cancelLabel = 'Cancel',
		pendingLabel = 'Working…',
		destructive = false,
		secondaryActionLabel,
		secondaryPendingLabel = 'Working…',
		secondaryDestructive = false,
		busy = false,
		error = null,
		onConfirm,
		onSecondaryAction,
		onCancel,
		children
	}: Props = $props();

	const messageId = $props.id();
	let activeAction = $state<'confirm' | 'secondary' | null>(null);
	let actionError = $state<string | null>(null);
	const inProgress = $derived(busy || activeAction !== null);
	const visibleError = $derived(error ?? actionError);

	$effect(() => {
		if (open) actionError = null;
	});

	async function submit(action: 'confirm' | 'secondary') {
		if (inProgress) return;
		actionError = null;
		activeAction = action;
		try {
			if (action === 'confirm') await onConfirm();
			else await onSecondaryAction?.();
		} catch {
			actionError = 'We couldn’t complete this action. Please try again.';
		} finally {
			activeAction = null;
		}
	}

	function cancel() {
		if (inProgress) return;
		actionError = null;
		onCancel();
	}
</script>

<ModalShell
	{open}
	{portal}
	{title}
	role="alertdialog"
	aria-describedby={messageId}
	onClose={cancel}
	dismissible={!inProgress}
	showCloseButton={false}
	closeOnBackdrop={false}
>
	<p id={messageId} class="whitespace-pre-line text-sm leading-6 text-ink-secondary">{message}</p>
	{#if children}
		<div class="mt-4">{@render children()}</div>
	{/if}
	{#if visibleError}
		<p role="alert" class="mt-3 text-[0.72rem] leading-5 text-danger">{visibleError}</p>
	{/if}

	{#snippet footer()}
		<div class="ml-auto flex flex-wrap justify-end gap-2" aria-busy={inProgress}>
			<Button variant="secondary" disabled={inProgress} onclick={cancel}>{cancelLabel}</Button>
			{#if secondaryActionLabel && onSecondaryAction}
				<Button
					variant="secondary"
					disabled={inProgress}
					class={secondaryDestructive
						? 'text-danger not-disabled:not-aria-disabled:hover:text-danger-hover'
						: undefined}
					onclick={() => submit('secondary')}
				>
					{activeAction === 'secondary' ? secondaryPendingLabel : secondaryActionLabel}
				</Button>
			{/if}
			<Button
				disabled={inProgress || confirmDisabled}
				class={destructive
					? 'bg-danger text-white not-disabled:not-aria-disabled:hover:bg-danger-hover'
					: undefined}
				onclick={() => submit('confirm')}
			>
				{activeAction === 'confirm' || (busy && activeAction === null)
					? pendingLabel
					: confirmLabel}
			</Button>
		</div>
	{/snippet}
</ModalShell>
