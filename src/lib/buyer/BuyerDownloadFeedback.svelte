<script lang="ts">
	import { getBuyerContract } from './contract.svelte';
	const contract = getBuyerContract();
	const download = contract.download;
</script>

{#if download.error}<p
		role="alert"
		class="mx-auto mb-4 max-w-lg px-5 text-center text-sm text-ink-muted"
	>
		{download.error}
		<button
			class="underline"
			disabled={Boolean(download.reason)}
			onclick={() => {
				void download.start();
			}}>Retry</button
		>
	</p>{/if}
