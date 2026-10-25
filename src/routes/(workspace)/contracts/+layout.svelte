<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';
	import ContractRoute from '$lib/components/workspace/ContractRoute.svelte';
	import DocumentBody from '$lib/auth/DocumentBody.svelte';
	let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<DocumentBody requiresBaseline={data.contractDestination.kind === 'new'} requiresDocument={false}>
	<ContractRoute data={data.contractDestination} />
</DocumentBody>
{@render children()}
