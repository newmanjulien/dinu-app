<script lang="ts">
	import { page } from '$app/state';
	import { describeRoute } from '$lib/auth/routes';
	import DocumentSkeleton from './DocumentSkeleton.svelte';
	let {
		label = 'Laying out contract pages',
		embedded = false,
		chrome = !embedded,
		hasPanel = false
	}: { label?: string; embedded?: boolean; chrome?: boolean; hasPanel?: boolean } = $props();
</script>

<div data-testid="pagination-loading">
	<DocumentSkeleton
		admin={describeRoute(page.route.id).document === 'admin'}
		{label}
		{embedded}
		{chrome}
		{hasPanel}
	/>
</div>
