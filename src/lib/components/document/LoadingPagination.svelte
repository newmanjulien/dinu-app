<script lang="ts">
	import { page } from '$app/state';
	import { describeRoute } from '$lib/auth/routes';
	import DocumentSkeleton from './DocumentSkeleton.svelte';
	let {
		label = 'Laying out contract pages',
		reviewGutter = 0
	}: {
		label?: string;
		reviewGutter?: number;
	} = $props();
</script>

<DocumentSkeleton
	admin={describeRoute(page.route.id).document === 'admin'}
	{label}
	{reviewGutter}
/>
