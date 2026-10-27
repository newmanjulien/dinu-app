<script lang="ts">
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import Button from '$lib/ui/Button.svelte';

	let { onClose }: { onClose: () => void } = $props();
</script>

<ModalShell
	title="Review complete"
	{onClose}
	maxWidth={420}
	showCloseButton={false}
	closeOnBackdrop={false}
>
	<p class="text-sm leading-6 text-ink-secondary">
		All concessions requiring approval have been reviewed. An email notification has been queued for
		the rep with the review results.
	</p>
	{#snippet footer()}
		<div class="ml-auto flex justify-end gap-2">
			<Button onclick={onClose}>Done</Button>
		</div>
	{/snippet}
</ModalShell>
