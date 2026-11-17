<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Role } from '../../../convex/permissions';
	import { resolve } from '$app/paths';
	import { getIntegrationCatalog, integrationActionLabels } from '$lib/integrations';
	import SearchField from '$lib/ui/SearchField.svelte';
	import Button from '$lib/ui/Button.svelte';
	import IntegrationAccess from './IntegrationAccess.svelte';
	let {
		role,
		entries = getIntegrationCatalog({}),
		loading = true,
		search = $bindable(''),
		notice
	}: {
		role?: Role;
		entries?: ReturnType<typeof getIntegrationCatalog>;
		loading?: boolean;
		search?: string;
		notice?: Snippet;
	} = $props();
</script>

<main
	class="min-h-[calc(100dvh-var(--app-header-height))] w-full bg-page px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-10 md:pb-6"
>
	<div class="mx-auto flex w-full max-w-[61.6rem] flex-col gap-6 pb-10 md:gap-7 md:pb-16">
		{#if role === 'admin'}
			<header>
				<h1 class="text-lg font-medium">Integrations</h1>
			</header>
			<SearchField
				disabled={loading}
				label="Search integrations"
				placeholder="Search integrations"
				bind:value={search}
			/>
			<section aria-label="Integration catalog">
				{#if notice}{@render notice()}{/if}
				<div class="overflow-hidden rounded-xl border-hairline border-edge">
					{#each entries as integration, index (integration.slug)}
						<div
							class="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-[11px] gap-y-3 border-edge/50 px-2 py-[9px] sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:gap-x-[15px] sm:px-3"
							class:border-t={index > 0}
						>
							<span
								class="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full border-hairline border-edge/50 bg-surface"
								aria-hidden="true"
							>
								<img
									src={integration.logoPath}
									alt=""
									width="40"
									height="40"
									class="size-full object-contain"
								/>
							</span>
							<div class="min-w-0">
								<div class="flex flex-wrap items-center gap-2">
									<h2 class="text-[13px] font-medium">{integration.name}</h2>
									{#if !loading && integration.status === 'installed'}
										<span
											class="rounded-full bg-success/10 px-1.75 py-0.25 text-[10.5px] text-success"
											>Installed</span
										>
									{/if}
								</div>
								<p class="mt-[5px] text-xs leading-5 text-ink-muted">
									{integration.summary}
								</p>
							</div>
							<Button
								variant="secondary"
								href={integration.status === 'comingSoon'
									? undefined
									: resolve('/(workspace)/integrations/[slug]', { slug: integration.slug })}
								disabled={integration.status === 'comingSoon'}
								class="col-start-2 h-8 justify-self-start rounded-[7px]! px-[9.5px] py-[3.5px] text-xs shadow-none disabled:bg-page sm:col-start-auto sm:justify-self-end"
								aria-label={integration.status === 'comingSoon'
									? `${integration.name} coming soon`
									: !loading && integration.status === 'installed'
										? `Manage ${integration.name}`
										: `Learn more about ${integration.name}`}
								>{loading && integration.status !== 'comingSoon'
									? 'Learn more'
									: integrationActionLabels[integration.status]}</Button
							>
						</div>
					{:else}
						<p role="status" class="px-5 py-9 text-center text-[13px] text-ink-muted">
							No integrations match your search.
						</p>
					{/each}
				</div>
			</section>
		{:else if role}
			<IntegrationAccess />
		{:else}
			<h1 class="text-lg font-medium">Integrations</h1>
		{/if}
	</div>
</main>
