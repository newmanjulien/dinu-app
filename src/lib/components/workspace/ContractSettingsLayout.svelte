<script lang="ts">
	import type { Snippet } from 'svelte';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import SettingsCardPlaceholder from '$lib/features/settings/SettingsCardPlaceholder.svelte';
	import { contractSettingsFields } from '$lib/features/settings/contract-settings-fields';
	let { id, title, children }: { id?: string; title?: string; children?: Snippet } = $props();
</script>

<main
	class="flex min-h-[calc(100dvh-var(--app-header-height))] w-full bg-page pt-8 md:pt-10"
	aria-busy={!children}
>
	<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 md:gap-7">
		<nav aria-label="Breadcrumb" class="text-[12.5px]">
			<ol class="flex min-w-0 items-center gap-2">
				<li class="min-w-0">
					{#if id}<a
							href={`/contracts/${id}`}
							class="block truncate rounded-button-sm text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
							>{title ?? 'Contract'}</a
						>
					{:else}<SkeletonBlock class="h-3 w-24" />{/if}
				</li>
				<li class="flex shrink-0 items-center gap-2">
					<CaretRightIcon class="size-3 text-ink-muted" aria-hidden="true" />
					<span aria-current="page">Contract settings</span>
				</li>
			</ol>
		</nav>
		<h1 class="text-lg font-medium">Contract settings</h1>
		{#if children}{@render children()}{:else}
			<SettingsCardPlaceholder card={contractSettingsFields.name} />
			<SettingsCardPlaceholder
				card={{ ...contractSettingsFields.danger, actionLabel: 'Delete contract' }}
			/>
		{/if}
	</div>
</main>
