<script lang="ts">
	import IntegrationCatalogLayout from './IntegrationCatalogLayout.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { useIntegrationCatalog } from '$lib/integration-catalog.svelte';

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

<IntegrationCatalogLayout role={allowed ? 'admin' : 'rep'} {entries} loading={false} bind:search>
	{#snippet notice()}
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
	{/snippet}
</IntegrationCatalogLayout>
