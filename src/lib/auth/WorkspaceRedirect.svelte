<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import WorkspacePresentationReporter from './WorkspacePresentationReporter.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';

	let {
		to,
		label = 'Opening your workspace',
		errorMessage = 'We couldn’t open your workspace. Please try again.',
		layout = 'workspace',
		disabled = false
	}: {
		to: string;
		label?: string;
		errorMessage?: string;
		layout?: 'screen' | 'workspace';
		disabled?: boolean;
	} = $props();

	let error = $state('');
	let retry = $state(0);

	$effect(() => {
		void retry;
		const target = to;
		if (disabled) {
			error = '';
			return;
		}
		let cancelled = false;
		untrack(() => {
			error = '';
			void goto(target, { replaceState: true }).catch(() => {
				if (!cancelled) error = errorMessage;
			});
		});
		return () => {
			cancelled = true;
		};
	});
</script>

<WorkspacePresentationReporter outcome={error ? 'error' : 'pending'} revision={retry} />
{#if layout === 'screen'}
	<main class="bg-page">
		<LoadingState layout="screen" label={error ? undefined : label}>
			{#if error}
				<p role="alert" class="text-sm">{error}</p>
				<button class="text-sm underline" onclick={() => retry++}>Try again</button>
			{/if}
		</LoadingState>
	</main>
{:else}
	<LoadingState layout="workspace" label={error ? undefined : label}>
		{#if error}
			<p role="alert" class="text-sm">{error}</p>
			<button class="text-sm underline" onclick={() => retry++}>Try again</button>
		{/if}
	</LoadingState>
{/if}
