<script lang="ts">
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import { page } from '$app/state';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { ArrowSquareOutIcon } from 'phosphor-svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { findIntegrationDetails } from '$lib/integrations';
	import Button from '$lib/ui/Button.svelte';
	import HubSpotUninstall from './HubSpotUninstall.svelte';
	import IntegrationDetailsLayout from './IntegrationDetailsLayout.svelte';

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

<IntegrationDetailsLayout
	role={allowed ? 'admin' : 'rep'}
	{integration}
	loading={false}
	bind:heading
>
	{#snippet actions()}
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
							: hubspot.data?.status === 'reconnect' || hubspot.data?.status === 'connected'
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
	{/snippet}
	{#snippet notice()}
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
				<p class="mt-4 text-[13px] leading-5.5 text-ink-muted">
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
	{/snippet}
</IntegrationDetailsLayout>
