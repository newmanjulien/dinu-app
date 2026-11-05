<script lang="ts">
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import Button from '$lib/ui/Button.svelte';

	let {
		onClose,
		onSend,
		onReset,
		busy = false,
		disabled = false,
		error = null
	}: {
		onClose: () => void;
		onSend: () => void;
		onReset: () => void;
		busy?: boolean;
		disabled?: boolean;
		error?: string | null;
	} = $props();
	let confirmingReset = $state(false);
</script>

<ModalShell
	title="Review complete"
	{onClose}
	maxWidth={420}
	showCloseButton={false}
	closeOnBackdrop={false}
	dismissible={!busy}
>
	<p class="text-sm leading-6 text-ink-secondary">
		{#if confirmingReset}
			This will reset everyone’s current approvals and rejections on this contract to pending. Your
			selected concessions will stay in place, and the results email will not be sent.
		{:else}
			All concessions requiring approval have been reviewed. Send the results to the rep, or reset
			all reviews to start again.
		{/if}
	</p>
	{#if error}<p class="mt-3 text-sm text-ink-secondary" role="alert">{error}</p>{/if}
	{#snippet footer()}
		<div class="ml-auto flex justify-end gap-2" aria-busy={busy}>
			{#if confirmingReset}
				<Button variant="secondary" disabled={busy} onclick={() => (confirmingReset = false)}
					>Keep reviews</Button
				>
				<Button disabled={busy || disabled} onclick={onReset}
					>{busy ? 'Resetting…' : 'Reset all reviews'}</Button
				>
			{:else}
				<Button
					variant="secondary"
					disabled={busy || disabled}
					onclick={() => (confirmingReset = true)}>Reset all reviews</Button
				>
				<Button disabled={busy || disabled} onclick={onSend}
					>{busy ? 'Queuing…' : 'Send results'}</Button
				>
			{/if}
		</div>
	{/snippet}
</ModalShell>
