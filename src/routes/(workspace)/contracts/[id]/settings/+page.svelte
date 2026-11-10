<script lang="ts">
	import type { PageProps } from './$types';
	import ContractSettings from '$lib/components/workspace/ContractSettings.svelte';
	let { params }: PageProps = $props();
</script>

{#key params.id}
	<ContractSettings id={params.id} />
{/key}
