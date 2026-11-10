<script lang="ts">
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import Button from '$lib/ui/Button.svelte';
	import type { Snippet } from 'svelte';
	let {
		open = true,
		announce = true,
		label = 'Loading contract creation',
		children,
		onOpen,
		onClose
	}: {
		open?: boolean;
		announce?: boolean;
		label?: string;
		children?: Snippet;
		onOpen?: () => void;
		onClose: () => void | Promise<void>;
	} = $props();
</script>

<ModalShell
	{open}
	title="Create a contract"
	{onOpen}
	{onClose}
	showCloseButton={false}
	closeOnBackdrop={false}
>
	{#if announce}<span role="status" class="sr-only">{label}</span>{/if}
	<SkeletonBlock class="h-9 w-full rounded-button-lg" />
	{#if children}<div class="mt-4 grid gap-3">{@render children()}</div>{/if}
	{#snippet footer()}
		<div class="ml-auto flex gap-2">
			<Button variant="secondary" onclick={onClose}>Cancel</Button>
			<Button disabled>Create contract</Button>
		</div>
	{/snippet}
</ModalShell>
