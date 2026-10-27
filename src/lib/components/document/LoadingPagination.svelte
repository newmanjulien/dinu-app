<script lang="ts">
	import { page } from '$app/state';
	import { describeRoute } from '$lib/auth/routes';
	import DocumentSkeleton from './DocumentSkeleton.svelte';
	let {
		label = 'Laying out contract pages',
		embedded = false,
		reviewGutter = 0,
		hasPanel = false
	}: {
		label?: string;
		embedded?: boolean;
		reviewGutter?: number;
		hasPanel?: boolean;
	} = $props();
</script>

<DocumentSkeleton
	admin={describeRoute(page.route.id).document === 'admin'}
	{label}
	{embedded}
	{reviewGutter}
	{hasPanel}
/>
