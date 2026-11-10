<script lang="ts">
	import { page } from '$app/state';
	import { describeRoute } from '$lib/auth/routes';
	import DocumentSkeleton from './DocumentSkeleton.svelte';
	let {
		label = 'Laying out document pages',
		reviewGutter = 0
	}: {
		label?: string;
		reviewGutter?: number;
	} = $props();
</script>

<DocumentSkeleton
	template={describeRoute(page.route.id).document === 'template'}
	{label}
	{reviewGutter}
/>
