<script lang="ts">
	let {
		onSubmit,
		error,
		busy,
		submitLabel
	}: {
		onSubmit: (name: string) => void;
		error?: string | null;
		busy?: boolean;
		submitLabel?: string;
		[key: string]: unknown;
	} = $props();
</script>

{#if error}<p role="alert">{error}</p>{/if}
<button disabled={busy} onclick={() => onSubmit('Buyer')}>{submitLabel}</button>
