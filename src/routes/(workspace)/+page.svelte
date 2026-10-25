<script lang="ts">
	import { onDestroy } from 'svelte';
	import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
	import { getHome, loadHome } from '$lib/components/workspace/home';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import HomeSkeleton from '$lib/components/workspace/HomeSkeleton.svelte';
	const Home = getHome();
	const attempt = Home ? undefined : new ReadAttempt(15_000);
	const home = Home ?? waitForRead(loadHome(), attempt!.signal).finally(() => attempt!.complete());
	onDestroy(() => attempt?.abort());
</script>

{#await home}
	<HomeSkeleton />
{:then Home}
	<Home />
{:catch}
	<LoadingState layout="workspace" class="bg-page text-sm">
		<p role="alert">We couldn’t load your contracts.</p>
		<button class="underline" onclick={() => location.reload()}>Try again</button>
	</LoadingState>
{/await}
