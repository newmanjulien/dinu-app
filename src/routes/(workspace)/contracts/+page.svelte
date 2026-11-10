<script lang="ts">
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { getContracts, loadContracts } from '$lib/components/workspace/contracts';
	import { loadModule } from '$lib/auth/component-loader.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import WorkspaceSkeleton from '$lib/auth/WorkspaceSkeleton.svelte';
	const contracts = loadModule(
		() => getContracts() ?? loadContracts(),
		() => true
	);
	const Contracts = $derived(contracts.module);
</script>

{#if Contracts}<Contracts />
{:else if contracts.failed}
	<WorkspacePresentationReporter outcome="error" />
	<LoadingState layout="workspace" class="bg-page text-sm">
		<p role="alert">We couldn’t load your contracts.</p>
		<button class="underline" onclick={() => contracts.retry()}>Try again</button>
	</LoadingState>
{:else}<WorkspaceSkeleton />{/if}
