<script lang="ts">
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import Button from '$lib/ui/Button.svelte';
	import type { PublicationWarning } from './publication-warning.svelte';
	let { warning, buyer }: { warning: PublicationWarning; buyer: string } = $props();
</script>

{#if warning.pending}
	<ModalShell
		title="This contract has a published buyer link"
		class="max-w-[420px]"
		showCloseButton={false}
		closeOnBackdrop={false}
		dismissible={!warning.busy}
		onClose={() => warning.cancel()}
	>
		<p class="text-sm leading-6 text-ink-secondary">
			Changes you approve will be visible to {buyer} through their buyer link. Related changes may wait
			until all required approvals are complete.
		</p>
		{#if warning.error}<p role="alert" class="mt-3 text-sm text-ink-secondary">
				{warning.error}
			</p>{/if}
		{#snippet footer()}<div class="ml-auto flex justify-end gap-2" aria-busy={warning.busy}>
				<Button variant="secondary" disabled={warning.busy} onclick={() => warning.cancel()}
					>Cancel</Button
				>
				<Button disabled={warning.busy} onclick={() => void warning.confirm()}
					>{warning.busy ? 'Continuing…' : warning.pending?.label}</Button
				>
			</div>{/snippet}
	</ModalShell>
{/if}
