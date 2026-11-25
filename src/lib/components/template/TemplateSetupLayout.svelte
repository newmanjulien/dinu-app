<script lang="ts">
	import type { Snippet } from 'svelte';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';

	let {
		title,
		description,
		loadingLabel,
		children
	}: {
		title: string;
		description?: string;
		loadingLabel?: string;
		children?: Snippet;
	} = $props();
</script>

<main
	class="min-h-[calc(100dvh-var(--app-header-height))] bg-page px-4 pt-16 pb-12 sm:px-6 sm:pt-22 sm:pb-16 md:px-8"
>
	<div
		class="mx-auto max-w-[558px] rounded-base border-hairline border-edge bg-surface p-5 shadow-card sm:p-6"
	>
		<header class="mb-6 text-left">
			<h1 class="text-[19px] leading-6 font-medium text-ink">
				{title}
			</h1>
			{#if description}
				<p class="mt-1 text-[13px] leading-6 text-ink-muted">
					{description}
				</p>
			{/if}
		</header>
		<div>
			{#if children}
				{@render children()}
			{:else}
				{#if loadingLabel}
					<span role="status" class="sr-only">{loadingLabel}</span>
				{/if}
				<div aria-hidden="true" class="space-y-4">
					<SkeletonBlock class="h-10 w-full rounded-button-lg" />
					<SkeletonBlock class="h-10 w-full rounded-button-lg" />
					<SkeletonBlock class="h-10 w-full rounded-button-lg" />
				</div>
			{/if}
		</div>
	</div>
</main>
