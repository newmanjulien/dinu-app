<script lang="ts">
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import { page } from '$app/state';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { ArrowSquareOutIcon, CaretRightIcon, HeadsetIcon } from 'phosphor-svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { findIntegrationDetails } from '$lib/integrations';
	import Button from '$lib/ui/Button.svelte';
	import { cn } from '$lib/ui/cn';

	let { slug }: { slug: string } = $props();
	const viewer = useViewer();
	const session = useViewerSession();
	const allowed = $derived(session.workspaceAdmitted && viewer().membership.role === 'admin');
	const hubspot = useHubSpotDeals().connection;
	const integration = $derived(allowed ? findIntegrationDetails(slug) : undefined);
	const details = $derived.by(() => {
		if (!integration) return [];
		const content = integration.content;
		return [
			{ label: 'Developer', value: content.developer, href: undefined },
			{ label: 'Category', value: content.category, href: undefined },
			...[
				{ label: 'Website', link: content.website },
				{ label: 'Documentation', link: content.documentation },
				{ label: `${integration.name} terms`, link: content.terms },
				{ label: 'Privacy policy', link: content.privacy },
				{ label: 'Support', link: content.support }
			].map(({ label, link }) => ({ label, value: link.label, href: link.href }))
		];
	});
</script>

<WorkspacePresentationReporter outcome="success" />

<main
	class="min-h-[calc(100dvh-var(--app-header-height))] bg-page px-3 py-3.5 sm:px-4 md:px-4.5 md:py-4.5"
>
	<div class="mx-auto max-w-[1400px]">
		<nav aria-label="Breadcrumb" class="mb-5 text-[12.5px]">
			<ol class="flex items-center gap-2">
				<li>
					<a
						href="/"
						class="rounded-button-sm text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					>
						Home
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
				<Button href="/" variant="secondary">Back to home</Button>
			</div>
		{:else if !integration}
			<div class="py-5">
				<h1 class="text-base font-medium">This integration isn’t available.</h1>
				<p class="mt-2 mb-4 text-sm text-ink-muted">
					Return home to see the available integrations.
				</p>
				<Button href="/" variant="secondary">Back to home</Button>
			</div>
		{:else}
			<article>
				<header class="border-b border-edge/50 pb-5 md:pb-6">
					<div class="flex flex-wrap items-start justify-between gap-4">
						<div class="min-w-0">
							<div class="flex items-center gap-3">
								<img
									src={integration.logoPath}
									alt=""
									width="48"
									height="48"
									class="size-12 rounded-full object-contain"
								/>
								<h1 class="text-xl font-medium">{integration.name}</h1>
							</div>
							<p class="mt-3 text-[13px] leading-5.5 text-ink-muted">
								{integration.content.tagline}
							</p>
						</div>
						<div class="flex flex-wrap items-center gap-2">
							{#if slug === 'hubspot'}
								<form method="POST" action="/api/hubspot/install" target="_blank" rel="noopener">
									<Button
										type="submit"
										disabled={!hubspot.data?.configured ||
											!hubspot.data?.enabled ||
											hubspot.data?.status === 'connected'}
										>{hubspot.data?.status === 'connected'
											? 'Installed'
											: hubspot.data?.status === 'reconnect'
												? 'Reconnect'
												: 'Install'}</Button
									>
								</form>
								{#if hubspot.data && (!hubspot.data.configured || !hubspot.data.enabled)}<span
										class="text-xs text-ink-muted">Installation is being configured.</span
									>{/if}
								{#if page.url.searchParams.get('installation') === 'failed'}<p
										class="text-sm text-danger"
										role="alert"
									>
										Installation did not finish. Try again using the original HubSpot account.
									</p>{/if}
							{:else}
								<a
									href={integration.content.website.href}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-button-lg px-3.5 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none bg-ink text-surface hover:bg-ink-secondary"
								>
									Website
								</a>
								<a
									href={integration.content.support.href}
									target="_blank"
									rel="noopener noreferrer"
									class={cn(
										'border-hairline border-edge bg-surface shadow-control transition-colors not-disabled:not-aria-disabled:hover:bg-surface-hover motion-reduce:transition-none',
										'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-button-lg px-3.5 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none',
										'text-ink shadow-none not-disabled:not-aria-disabled:hover:bg-field-hover'
									)}
								>
									{integration.name} Support <HeadsetIcon class="size-[15px]" aria-hidden="true" />
								</a>
							{/if}
						</div>
					</div>
				</header>
				<div class="grid items-start gap-7 py-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-11">
					<div class="min-w-0 space-y-7 text-[13px] leading-5.5">
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
					<aside aria-labelledby="details-heading" class="min-w-0">
						<h2 id="details-heading" class="mb-2 text-base font-medium">Details</h2>
						<dl class="text-[12.5px]">
							{#each details as detail (detail.label)}
								<div
									class="flex items-baseline justify-between gap-4 border-b border-edge/50 py-3.5 last:border-b-0"
								>
									<dt class="shrink-0 text-ink-secondary">{detail.label}</dt>
									<dd class="min-w-0 text-right">
										{#if detail.href}
											<a
												href={detail.href}
												target="_blank"
												rel="noopener noreferrer"
												class="inline-flex items-center gap-1 rounded-button-sm text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
												aria-label={`${detail.label}: ${detail.value}`}
											>
												{detail.value}
												<ArrowSquareOutIcon class="size-3 shrink-0" aria-hidden="true" />
											</a>
										{:else}
											{detail.value}
										{/if}
									</dd>
								</div>
							{/each}
						</dl>
					</aside>
				</div>
			</article>
		{/if}
	</div>
</main>
