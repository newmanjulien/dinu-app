<script lang="ts">
	import AuthStepFrame from './components/AuthStepFrame.svelte';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	let {
		entry = 'unknown',
		announce = true
	}: { entry?: 'signed-in' | 'signed-out' | 'unknown'; announce?: boolean } = $props();
</script>

{#if announce}<span role="status" class="sr-only">Loading invitation</span>{/if}
<AuthStepFrame title={entry === 'signed-out' ? 'Welcome to Dinu' : 'Company invitation'}>
	{#snippet description()}
		<div aria-hidden="true" class="grid min-h-10 content-center justify-items-center gap-1.5">
			<SkeletonBlock class="h-3.5 w-full" />
			<SkeletonBlock class="h-3.5 w-4/5" />
		</div>
	{/snippet}
	{#if entry !== 'unknown'}
		<SkeletonBlock class="h-button-sm w-full rounded-button-lg" />
	{/if}
</AuthStepFrame>
