<script lang="ts">
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { onDestroy } from 'svelte';
	import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
	import { getHome, loadHome } from '$lib/components/workspace/home';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import HomeSkeleton from '$lib/components/workspace/HomeSkeleton.svelte';
	import { useViewer } from '$lib/auth/viewer-session.svelte';
	const viewer = useViewer();
	const Home = getHome();
	const attempt = Home ? undefined : new ReadAttempt(15_000);
	const home = Home ?? waitForRead(loadHome(), attempt!.signal).finally(() => attempt!.complete());
	onDestroy(() => attempt?.abort());
</script>

{#await home}
	<HomeSkeleton admin={viewer().membership.role === 'admin'} />
{:then Home}
	<Home />
{:catch}
	<WorkspacePresentationReporter outcome="error" />
	<LoadingState layout="workspace" class="bg-page text-sm">
		<p role="alert">We couldn’t load your contracts.</p>
		<button class="underline" onclick={() => location.reload()}>Try again</button>
	</LoadingState>
{/await}
