<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import { describeRoute } from './routes';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import HomeSkeleton from '$lib/components/workspace/HomeSkeleton.svelte';
	import TeamRowsSkeleton from '$lib/components/workspace/TeamRowsSkeleton.svelte';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';
	let {
		header = false,
		label = 'Loading your workspace',
		announce = true,
		children
	}: { header?: boolean; label?: string; announce?: boolean; children?: Snippet } = $props();
	const route = $derived(describeRoute(page.route.id));
</script>

{#if announce}<span role="status" class="sr-only">{label}</span>{/if}
{#if header}
	<div
		class="flex h-[var(--app-header-height)] items-center gap-5 border-b-[length:var(--surface-border-width)] border-line bg-surface px-[3px] sm:px-[7px] md:px-[13px]"
		aria-hidden="true"
	>
		<SkeletonBlock class="h-[15px] w-8" />
		<SkeletonBlock class="h-[15px] w-9" />
		<SkeletonBlock class="ml-auto size-[25px] shrink-0 rounded-full" />
	</div>
{/if}
{#if route.document}
	<DocumentSkeleton admin={route.document === 'admin'} announce={false} />
{:else if page.route.id === '/(workspace)'}
	<HomeSkeleton announce={false} />
{:else if page.route.id === '/(workspace)/settings'}
	<div
		class="min-h-[calc(100dvh-var(--app-header-height))] bg-page px-3 py-4 md:px-6 md:py-6"
		aria-hidden="true"
	>
		<div class="mx-auto flex max-w-4xl flex-col gap-6 pb-10 md:gap-7 md:pb-16">
			{#each ['Your name', 'Sign-in email', '', ''] as title, index (index)}
				<div class="overflow-hidden rounded-xl border-hairline border-edge bg-surface shadow-card">
					<div class="min-h-36 px-4 py-5 sm:px-5">
						{#if title}<div class="text-[0.82rem] leading-5 text-ink">{title}</div>
						{:else}<SkeletonBlock class="h-[23px] w-24" />{/if}
						<SkeletonBlock class="mt-3 h-[23px] w-72 max-w-full" />
						<SkeletonBlock
							class="mt-4 h-9 max-w-sm rounded-button-lg border-hairline border-edge shadow-control"
						/>
						{#if index === 0}<div class="mt-2 h-5"></div>{/if}
					</div>
					<div
						class="flex min-h-12 flex-col gap-3 border-t-[length:var(--surface-border-width)] border-line bg-page px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"
					>
						<SkeletonBlock class="h-[15px] w-64 max-w-[80%]" />
						{#if index !== 1}<div class="flex shrink-0 justify-end">
								<SkeletonBlock class="h-8 w-14 rounded-button-lg" />
							</div>{/if}
					</div>
				</div>
			{/each}
		</div>
	</div>
{:else if page.route.id === '/(workspace)/team'}
	<div
		class="min-h-[calc(100dvh-var(--app-header-height))] bg-surface px-6 py-8"
		aria-hidden="true"
	>
		<div class="mx-auto max-w-4xl space-y-8">
			<div>
				<SkeletonBlock class="h-[23px] w-40" />
				<SkeletonBlock class="mt-2 h-[23px] w-96 max-w-full" />
			</div>
			<div>
				<div class="mb-3 text-sm font-medium">Colleagues</div>
				<TeamRowsSkeleton />
			</div>
		</div>
	</div>
{:else}
	<LoadingState layout={header ? 'screen' : 'workspace'} />
{/if}
{#if children}
	<div
		class="fixed inset-x-3 bottom-4 z-50 mx-auto grid max-w-md justify-items-center gap-3 rounded-xl border-hairline border-edge bg-surface p-5 text-center shadow-floating"
	>
		{@render children()}
	</div>
{/if}
