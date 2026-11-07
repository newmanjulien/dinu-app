<script lang="ts">
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'clsx';
	import { cn } from '$lib/ui/cn';
	import IconButton from '$lib/ui/IconButton.svelte';
	import { createModalBehavior } from '$lib/ui/modal-behavior.svelte';

	type Props = {
		open?: boolean;
		title: string;
		onClose: () => void | Promise<void>;
		variant?: 'dialog' | 'panel';
		position?: 'center' | 'right';
		class?: ClassValue;
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
		class: className = '',
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
	oncancel={handleCancel}
	onpointerdown={(event) => (pointerStartedOnBackdrop = event.target === event.currentTarget)}
	onclick={handleBackdropClick}
>
	<div
		class={cn(
			'flex max-h-full min-h-0 w-full flex-col overflow-hidden rounded-modal border-hairline border-edge bg-surface',
			position === 'right' ? 'ml-auto' : 'mx-auto',
			variant === 'panel'
				? 'h-full max-w-[480px] shadow-floating max-[600px]:max-w-none max-[600px]:rounded-none max-[600px]:border-0 max-[600px]:shadow-none'
				: 'max-w-[440px] shadow-dialog',
			className
		)}
	>
		<header class="flex shrink-0 items-start justify-between gap-4 p-5">
			<h2 id={titleId} class="min-w-0 text-[17px] leading-tight font-medium text-ink">{title}</h2>
			{#if showCloseButton}
				<IconButton
					aria-label="Close modal"
					variant="ghost"
					class="-my-1.5 -mr-1.5"
					disabled={!dismissible}
					onclick={requestClose}
				>
					<XIcon aria-hidden="true" class="size-5" weight="regular" />
				</IconButton>
			{/if}
		</header>

		<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
			{@render children?.()}
		</div>

		{#if footer}
			<footer
				class="flex shrink-0 items-center justify-between gap-3 border-t-[length:var(--surface-border-width)] border-line px-5 py-4.5"
			>
				{@render footer()}
			</footer>
		{/if}
	</div>
</dialog>
