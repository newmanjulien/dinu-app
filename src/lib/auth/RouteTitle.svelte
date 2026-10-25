<script lang="ts">
	import { page } from '$app/state';
	import { getPageMetadata } from './page-metadata.svelte';
	let { title }: { title: string } = $props();
	const metadata = getPageMetadata();
	$effect(() => metadata.register(title, page.route.id));
</script>
