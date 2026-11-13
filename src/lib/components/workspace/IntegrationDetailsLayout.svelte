<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import { CaretRightIcon } from 'phosphor-svelte';
	import { findIntegrationDetails } from '$lib/integrations';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import Button from '$lib/ui/Button.svelte';
	import IntegrationAccess from './IntegrationAccess.svelte';
	import IntegrationScreenshots from './IntegrationScreenshots.svelte';

	let {
		role,
		integration,
		loading = true,
		heading = $bindable<HTMLHeadingElement>(),
		actions,
		notice
	}: {
		role?: 'admin' | 'rep';
		integration?: ReturnType<typeof findIntegrationDetails>;
		loading?: boolean;
		heading?: HTMLHeadingElement;
		actions?: Snippet;
		notice?: Snippet;
	} = $props();
</script>

<main
	class="min-h-[calc(100dvh-var(--app-header-height))] bg-page px-4 py-3.5 sm:px-6 md:px-8 md:py-4.5"
>
	<div class="mx-auto max-w-[1200px]">
		<nav aria-label="Breadcrumb" class="mb-8 text-[12.5px]">
			<ol class="flex items-center gap-2">
				<li>
					<a
						href={role === 'admin' ? resolve('/integrations') : resolve('/contracts')}
						class="rounded-button-sm text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					>
						{role === 'admin' ? 'Integrations' : 'Contracts'}
					</a>
				</li>
				<li class="flex items-center gap-2">
					<CaretRightIcon class="size-3 text-ink-muted" aria-hidden="true" />
					<span aria-current="page">{integration?.name ?? 'Integrations'}</span>
				</li>
			</ol>
		</nav>
		{#if role && role !== 'admin'}
			<IntegrationAccess />
		{:else if !role}
			<SkeletonBlock class="h-7 w-36" />
		{:else if !integration}
			<IntegrationAccess reason="unavailable" />
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
							{#if actions}{@render actions()}{:else if loading}<Button disabled
									>Checking installation…</Button
								>{/if}
						</div>
					</div>
					{@render notice?.()}
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
