<script lang="ts">
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { useIntegrationCatalog } from '$lib/integration-catalog.svelte';
	import { integrationActionLabels } from '$lib/integrations';
	import Button from '$lib/ui/Button.svelte';
	import Hint from '$lib/ui/Hint.svelte';
	import HelpHint from '$lib/ui/HelpHint.svelte';
	import { recordHintVisit } from '$lib/ui/hint-visits';

	const viewer = useViewer();
	const session = useViewerSession();
	let visibleCount = $state(3);
	const allowed = $derived(session.workspaceAdmitted && viewer().membership.role === 'admin');
	const catalog = useIntegrationCatalog();
	const hintVisits = new Map<string, boolean>();
	let showIntroduction = $state(false);
	$effect(() => {
		if (!allowed) {
			showIntroduction = false;
			return;
		}
		const membershipId = viewer().membership.id;
		if (!hintVisits.has(membershipId)) {
			hintVisits.set(membershipId, recordHintVisit('integrationsIntro', membershipId));
		}
		showIntroduction = hintVisits.get(membershipId)!;
	});
</script>

{#if allowed}
	<section aria-labelledby="integrations-heading" class="min-w-0">
		<div class="mb-3 flex items-center gap-1.5">
			<h2 id="integrations-heading" class="text-[13.5px] font-medium">Integrations</h2>
			<HelpHint id="integrationsIntro" label="About integrations" />
		</div>
		<div class="overflow-hidden rounded-xl border-hairline border-edge bg-surface shadow-card">
			{#each catalog.entries.slice(0, visibleCount) as integration, index (integration.slug)}
				<div class="flex items-start gap-3 border-edge/50 px-3.5 py-3" class:border-t={index > 0}>
					<span
						class="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full border-hairline border-edge/50 bg-surface"
						aria-hidden="true"
					>
						<img
							src={integration.logoPath}
							alt=""
							width="36"
							height="36"
							class="size-full object-contain"
						/>
					</span>
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<h3 class="text-[13.5px] font-medium">{integration.name}</h3>
							{#if integration.status === 'installed'}
								<span
									class="rounded-full bg-success/10 px-1.75 py-0.25 text-[10.5px] font-normal text-success"
								>
									Installed
								</span>
							{/if}
						</div>
						<p class="mt-1.5 text-xs text-ink-muted">{integration.summary}</p>
					</div>
					<Button
						variant="secondary"
						href={integration.status === 'comingSoon'
							? undefined
							: `/integrations/${integration.slug}`}
						disabled={integration.status === 'comingSoon'}
						class="h-[31px] rounded-[7px]! self-center px-[9.5px] py-1 text-[11.75px] shadow-none not-disabled:not-aria-disabled:hover:bg-field-hover disabled:bg-field-hover"
						aria-label={integration.status === 'comingSoon'
							? `${integration.name} coming soon`
							: integration.status === 'installed'
								? `Manage ${integration.name}`
								: `Learn more about ${integration.name}`}
						>{integrationActionLabels[integration.status]}</Button
					>
				</div>
			{/each}
			{#if catalog.entries.length > visibleCount}
				<button
					type="button"
					onclick={() => {
						visibleCount += 3;
					}}
					class="flex h-[35px] w-full cursor-pointer items-center justify-center border-t border-edge/50 text-[11.75px] text-ink-secondary transition-colors hover:bg-field-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
					>Show more</button
				>
			{/if}
		</div>
		{#if showIntroduction}
			<Hint id="integrationsIntro" class="mt-3" />
		{/if}
	</section>
{/if}
