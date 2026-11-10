<script lang="ts">
	import { resolve } from '$app/paths';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import { page } from '$app/state';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { ArrowSquareOutIcon, CaretRightIcon } from 'phosphor-svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { findIntegrationDetails } from '$lib/integrations';
	import Button from '$lib/ui/Button.svelte';
	import HubSpotUninstall from './HubSpotUninstall.svelte';
	import IntegrationScreenshots from './IntegrationScreenshots.svelte';

	let { slug }: { slug: string } = $props();
	const viewer = useViewer();
	const session = useViewerSession();
	const allowed = $derived(session.workspaceAdmitted && viewer().membership.role === 'admin');
	const hubspot = useHubSpotDeals().connection;
	const integration = $derived(allowed ? findIntegrationDetails(slug) : undefined);
	const removal = $derived(
		slug === 'hubspot' &&
			hubspot.data?.status !== 'connected' &&
			hubspot.data?.status !== 'reconnect'
			? hubspot.data?.removal
			: null
	);
	let heading = $state<HTMLHeadingElement>();
	function focusHeading() {
		if (heading?.isConnected) heading.focus({ preventScroll: true });
	}
</script>

<WorkspacePresentationReporter outcome="success" />

<main
	class="min-h-[calc(100dvh-var(--app-header-height))] bg-page px-4 py-3.5 sm:px-6 md:px-8 md:py-4.5"
>
	<div class="mx-auto max-w-[1200px]">
		<nav aria-label="Breadcrumb" class="mb-8 text-[12.5px]">
			<ol class="flex items-center gap-2">
				<li>
					<a
						href={allowed ? resolve('/integrations') : resolve('/contracts')}
						class="rounded-button-sm text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					>
						{allowed ? 'Integrations' : 'Contracts'}
					</a>
				</li>
				<li class="flex items-center gap-2">
					<CaretRightIcon class="size-3 text-ink-muted" aria-hidden="true" />
					<span aria-current="page">{integration?.name ?? 'Integrations'}</span>
				</li>
			</ol>
		</nav>
		{#if !allowed}
			<div class="py-5">
				<h1 class="text-base font-medium">Integrations are available to admins</h1>
				<p class="mt-2 mb-4 text-sm text-ink-muted">Ask a workspace admin about integrations.</p>
				<Button href={resolve('/contracts')} variant="secondary">Back to Contracts</Button>
			</div>
		{:else if !integration}
			<div class="py-5">
				<h1 class="text-base font-medium">This integration isn’t available.</h1>
				<p class="mt-2 mb-4 text-sm text-ink-muted">
					Return to Integrations to see the available integrations.
				</p>
				<Button href={resolve('/integrations')} variant="secondary">Back to integrations</Button>
			</div>
		{:else}
			<article>
				<header class="border-b border-edge/50 pb-5 md:pb-6">
					<div class="flex flex-wrap items-start justify-between gap-4">
						<div class="min-w-0 flex-1 basis-80">
							<div class="flex items-center gap-3">
								<img
									src={integration.logoPath}
									alt=""
									width="48"
									height="48"
									class="size-12 rounded-full object-contain"
								/>
								<h1 bind:this={heading} tabindex="-1" class="text-xl font-medium outline-none">
									{integration.name}
								</h1>
							</div>
							<p class="mt-3 text-[13px] leading-5.5 text-ink-muted">
								{integration.content.tagline}
							</p>
						</div>
						<div class="flex max-w-full flex-wrap items-center gap-2 md:ml-auto md:justify-end">
							{#if slug === 'hubspot'}
								<form method="POST" action="/api/hubspot/install" target="_blank" rel="noopener">
									<Button
										type="submit"
										disabled={hubspot.isLoading ||
											Boolean(hubspot.error) ||
											!hubspot.data?.configured ||
											!hubspot.data?.enabled ||
											hubspot.data?.status === 'uninstalling' ||
											hubspot.data?.removal?.blocking ||
											(hubspot.data?.status === 'connected' && hubspot.data.companyReadGranted)}
										>{hubspot.data?.status === 'uninstalling'
											? 'Uninstalling…'
											: hubspot.data?.status === 'connected' && hubspot.data.companyReadGranted
												? 'Installed'
												: hubspot.data?.status === 'reconnect' ||
													  hubspot.data?.status === 'connected'
													? 'Reconnect'
													: hubspot.data
														? 'Install'
														: 'Checking installation…'}</Button
									>
								</form>
								<HubSpotUninstall onUninstalled={focusHeading} />
							{:else if slug === 'hubspot-quote'}
								<form
									method="POST"
									action="/api/hubspot/install?purpose=quotes"
									target="_blank"
									rel="noopener"
								>
									<Button
										type="submit"
										disabled={hubspot.isLoading ||
											Boolean(hubspot.error) ||
											!hubspot.data?.configured ||
											!hubspot.data?.enabled ||
											!hubspot.data?.quotes?.enabled ||
											hubspot.data?.status !== 'connected' ||
											hubspot.data?.quotes?.connected}
									>
										{hubspot.data?.quotes?.connected
											? 'Installed'
											: hubspot.data?.quotes?.installed
												? 'Reconnect'
												: hubspot.data
													? 'Install'
													: 'Checking installation…'}
									</Button>
								</form>
								<HubSpotUninstall quotes onUninstalled={focusHeading} />
							{/if}
						</div>
					</div>
					{#if slug === 'hubspot' || slug === 'hubspot-quote'}
						{#if hubspot.error}
							<p role="alert" class="mt-4 text-sm text-ink-muted">
								We couldn’t check installation. <button
									class="rounded-button-sm text-accent underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
									onclick={() => hubspot.retry?.()}>Try again</button
								>
							</p>
						{/if}
						{#if slug === 'hubspot'}
							{#if hubspot.data && (!hubspot.data.configured || !hubspot.data.enabled)}
								<p class="mt-4 text-sm text-ink-muted">Installation is being configured.</p>
							{/if}
						{:else if hubspot.data && hubspot.data.status !== 'connected'}
							<p class="mt-4 text-sm text-ink-muted">
								<a
									class="rounded-button-sm text-accent underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
									href="/integrations/hubspot">Connect HubSpot</a
								> before installing HubSpot Quotes.
							</p>
						{:else if hubspot.data && !hubspot.data.quotes?.enabled}
							<p class="mt-4 text-sm text-ink-muted">Installation is being configured.</p>
						{/if}
						{#if page.url.searchParams.get('installation') === 'failed'}
							<p class="mt-4 text-sm text-danger" role="alert">
								{#if slug === 'hubspot'}
									Installation did not finish. Try again using the original HubSpot account.
								{:else}
									Installation did not finish. Use the same HubSpot account and approve both Quotes
									permissions.
								{/if}
							</p>
						{/if}
					{/if}
					{#if removal?.done && removal.provider !== 'confirmed' && removal.provider !== 'shared'}
						<div class="mt-4 space-y-1 text-sm leading-6 text-ink-muted">
							<a
								href="https://knowledge.hubspot.com/integrations/connect-apps-to-hubspot#uninstall-an-app"
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1 rounded-button-sm text-accent underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
							>
								{removal.provider === 'unknown'
									? 'Check uninstall status in HubSpot'
									: 'Finish uninstalling in HubSpot'}
								<ArrowSquareOutIcon class="size-3 shrink-0" aria-hidden="true" />
							</a>
							{#if removal.blocking}
								<p>Reinstall is unavailable until removal is confirmed.</p>
							{/if}
						</div>
					{/if}
					{#if removal?.done && removal.provider === 'shared'}
						<p class="mt-4 text-[12.5px] leading-5.5 text-ink-secondary">
							Other workspaces remain connected.
						</p>
					{/if}
				</header>
				<div class="min-w-0 space-y-7 py-6 text-[13px] leading-5.5">
					{#if integration.content.screenshots.length}
						<IntegrationScreenshots
							name={integration.name}
							screenshots={integration.content.screenshots}
						/>
					{/if}
					{#each integration.content.sections as section (section.key)}
						<section aria-labelledby={`integration-section-${section.key}`}>
							<h2 id={`integration-section-${section.key}`} class="mb-3 text-base font-medium">
								{section.title}
							</h2>
							{#each section.paragraphs as paragraph, index (index)}
								<p class="text-ink-secondary" class:mt-3.5={index > 0}>{paragraph}</p>
							{/each}
						</section>
					{/each}
				</div>
			</article>
		{/if}
	</div>
</main>
