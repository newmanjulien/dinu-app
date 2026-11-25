<script lang="ts">
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import Button from '$lib/ui/Button.svelte';

	let {
		onClose,
		onSend,
		busy = false,
		disabled = false,
		error = null
	}: {
		onClose: () => void;
		onSend: () => void;
		busy?: boolean;
		disabled?: boolean;
		error?: string | null;
	} = $props();
</script>

<ModalShell
	title="Review complete"
	{onClose}
	class="max-w-[420px]"
	showCloseButton={false}
	closeOnBackdrop={false}
	dismissible={!busy}
>
	<p class="text-sm leading-6 text-ink-secondary">
		All concessions requiring approval have been reviewed. Send the results to the rep.
	</p>
	{#if error}<p class="mt-3 text-sm text-ink-secondary" role="alert">{error}</p>{/if}
	{#snippet footer()}
		<div class="ml-auto flex justify-end gap-2" aria-busy={busy}>
			<Button disabled={busy || disabled} onclick={onSend}
				>{busy ? 'Queuing…' : 'Send results'}</Button
			>
		</div>
	{/snippet}
</ModalShell>
