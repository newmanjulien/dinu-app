<script lang="ts">
	import { resolve } from '$app/paths';
	import SearchField from '$lib/ui/SearchField.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { useIntegrationCatalog } from '$lib/integration-catalog.svelte';
	import { integrationActionLabels } from '$lib/integrations';
	import Button from '$lib/ui/Button.svelte';

	const viewer = useViewer();
	const session = useViewerSession();
	const allowed = $derived(session.workspaceAdmitted && viewer().membership.role === 'admin');
	const catalog = useIntegrationCatalog();
	let search = $state('');
	const query = $derived(search.trim().toLowerCase());
	const entries = $derived(
		catalog.entries.filter((entry) =>
			`${entry.name} ${entry.summary}`.toLowerCase().includes(query)
		)
	);
</script>

<WorkspacePresentationReporter outcome="success" />

<main
	class="min-h-[calc(100dvh-var(--app-header-height))] w-full bg-page px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-10 md:pb-6"
>
	<div class="mx-auto flex w-full max-w-[61.6rem] flex-col gap-6 pb-10 md:gap-7 md:pb-16">
		{#if allowed}
			<header>
				<h1 class="text-lg font-medium">Integrations</h1>
			</header>
			<SearchField
				label="Search integrations"
				placeholder="Search integrations"
				bind:value={search}
			/>
			<section aria-label="Integration catalog">
				{#if catalog.error}
					<p role="alert" class="mb-3 text-xs">
						Couldn’t check installation. <button
							class="cursor-pointer underline"
							onclick={() => catalog.retry()}>Try again</button
						>
					</p>
				{:else if catalog.loading}
					<p role="status" class="mb-3 text-xs text-ink-muted">Checking installation…</p>
				{/if}
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
									{#if integration.status === 'installed'}
										<span
											class="rounded-full bg-success/10 px-1.75 py-0.25 text-[10.5px] text-success"
											>Installed</span
										>
									{/if}
								</div>
								<p class="mt-[5px] text-xs leading-5 text-ink-muted">{integration.summary}</p>
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
									: integration.status === 'installed'
										? `Manage ${integration.name}`
										: `Learn more about ${integration.name}`}
								>{integrationActionLabels[integration.status]}</Button
							>
						</div>
					{:else}
						<p role="status" class="px-5 py-9 text-center text-[13px] text-ink-muted">
							No integrations match your search.
						</p>
					{/each}
				</div>
			</section>
		{:else}
			<div class="py-5">
				<h1 class="text-base font-medium">Integrations are available to admins</h1>
				<p class="mt-2 mb-4 text-sm text-ink-muted">Ask a workspace admin about integrations.</p>
				<Button href={resolve('/contracts')} variant="secondary">Back to Contracts</Button>
			</div>
		{/if}
	</div>
</main>
