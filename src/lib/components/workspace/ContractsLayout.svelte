<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Role } from '../../../convex/permissions';
	import SearchField from '$lib/ui/SearchField.svelte';
	import Button from '$lib/ui/Button.svelte';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import ContractsResultsLayout from './ContractsResultsLayout.svelte';
	let {
		role,
		toolbar,
		children
	}: {
		role?: Role;
		toolbar?: Snippet;
		children?: Snippet;
	} = $props();
</script>

<main
	class="contracts min-h-[calc(100dvh-var(--app-header-height))] bg-page px-4 py-4 sm:px-6 md:px-8 md:py-5"
>
	<div class="mx-auto max-w-[1800px]">
		<h1 class="sr-only">Contracts</h1>
		<div class="mb-6 flex items-center gap-2">
			{#if toolbar}{@render toolbar()}{:else}
				<SearchField
					label="Search contracts and buyer links"
					placeholder="Search by name of company"
					disabled
				/>
				<Button disabled><PlusIcon class="size-[15px]" aria-hidden="true" />New contract</Button>
			{/if}
		</div>
		{#if children}{@render children()}{:else}
			<ContractsResultsLayout {role} showHeadings={false} />
		{/if}
	</div>
</main>
