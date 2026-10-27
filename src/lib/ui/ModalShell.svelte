<script lang="ts">
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/ui/cn';
	import IconButton from '$lib/ui/IconButton.svelte';
	import { createModalBehavior } from '$lib/ui/modal-behavior.svelte';

	type Props = {
		open?: boolean;
		title: string;
		onClose: () => void | Promise<void>;
		variant?: 'dialog' | 'panel';
		position?: 'center' | 'right';
		maxWidth?: number;
		contentPadding?: number;
		dismissible?: boolean;
		showCloseButton?: boolean;
		closeOnBackdrop?: boolean;
		onOpen?: () => void;
		footer?: Snippet;
		children?: Snippet;
	};

	let {
		open = true,
		title,
		onClose,
		variant = 'dialog',
		position = 'center',
		maxWidth,
		contentPadding,
		dismissible = true,
		showCloseButton = true,
		closeOnBackdrop = true,
		onOpen,
		footer,
		children
	}: Props = $props();

	const titleId = $props.id();
	const modalBehavior = createModalBehavior({
		isOpen: () => open,
		onOpen: () => onOpen?.()
	});
	let pointerStartedOnBackdrop = false;

	function requestClose() {
		if (dismissible) void onClose();
	}

	function handleCancel(event: Event) {
		// The owner changes `open` or unmounts the modal after accepting dismissal.
		event.preventDefault();
		requestClose();
	}

	function handleBackdropClick(event: MouseEvent) {
		if (closeOnBackdrop && pointerStartedOnBackdrop && event.target === event.currentTarget) {
			requestClose();
		}
		pointerStartedOnBackdrop = false;
	}
</script>

<dialog
	bind:this={modalBehavior.dialogElement}
	aria-labelledby={titleId}
	class={cn(
		'fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-hidden border-0 bg-transparent text-ink outline-none open:flex open:items-center',
		variant === 'panel'
			? 'p-4 backdrop:bg-canvas/70 max-[600px]:p-0'
			: 'px-4 py-6 backdrop:bg-ink/25'
	)}
	style:--modal-width={`${maxWidth ?? (variant === 'panel' ? 480 : 440)}px`}
	style:--modal-padding={contentPadding === undefined
		? 'var(--spacing-modal)'
		: `${contentPadding}px`}
	oncancel={handleCancel}
	onpointerdown={(event) => (pointerStartedOnBackdrop = event.target === event.currentTarget)}
	onclick={handleBackdropClick}
>
	<div
		class={cn(
			'flex max-h-full min-h-0 w-full max-w-[var(--modal-width)] flex-col overflow-hidden rounded-modal border-hairline border-edge bg-surface',
			position === 'right' ? 'ml-auto' : 'mx-auto',
			variant === 'panel'
				? 'h-full shadow-floating max-[600px]:max-w-none max-[600px]:rounded-none max-[600px]:border-0 max-[600px]:shadow-none'
				: 'shadow-dialog'
		)}
	>
		<header class="flex shrink-0 items-start justify-between gap-4 p-[var(--modal-padding)]">
			<h2 id={titleId} class="min-w-0 text-[17px] leading-tight font-medium text-ink">{title}</h2>
			{#if showCloseButton}
				<IconButton
					aria-label="Close modal"
					variant="ghost"
					class="-my-1.5 -mr-1.5"
					disabled={!dismissible}
					onclick={requestClose}
				>
					<XIcon aria-hidden="true" size={20} weight="regular" />
				</IconButton>
			{/if}
		</header>

		<div
			class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[var(--modal-padding)] pb-[var(--modal-padding)]"
		>
			{@render children?.()}
		</div>

		{#if footer}
			<footer
				class="flex shrink-0 items-center justify-between gap-3 border-t-[length:var(--surface-border-width)] border-line p-[var(--modal-padding)]"
			>
				{@render footer()}
			</footer>
		{/if}
	</div>
</dialog>
