<script lang="ts">
	import type { PageProps } from './$types';
	import IntegrationDetails from '$lib/components/workspace/IntegrationDetails.svelte';
	let { params }: PageProps = $props();
</script>

{#key params.slug}
	<IntegrationDetails slug={params.slug} />
{/key}
