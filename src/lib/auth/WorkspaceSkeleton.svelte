<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import { describeRoute } from './routes';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import IntegrationCatalogSkeleton from '$lib/components/workspace/IntegrationCatalogSkeleton.svelte';
	import ContractsSkeleton from '$lib/components/workspace/ContractsSkeleton.svelte';
	import SettingsSkeleton from '$lib/components/workspace/SettingsSkeleton.svelte';
	import ContractSettingsSkeleton from '$lib/components/workspace/ContractSettingsSkeleton.svelte';
	import TeamSkeleton from '$lib/components/workspace/TeamSkeleton.svelte';
	import { useWorkspaceRole } from './workspace-role.svelte';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';
	import TemplateSetupSkeleton from '$lib/components/template/TemplateSetupSkeleton.svelte';
	import ContractCreationSkeleton from '$lib/components/workspace/ContractCreationSkeleton.svelte';
	import IntegrationAccessSkeleton from '$lib/components/workspace/IntegrationAccessSkeleton.svelte';
	import { findIntegrationDetails } from '$lib/integrations';
	import { goto } from '$app/navigation';
	import { useAccount } from './viewer-session.svelte';
	let {
		header = false,
		label = 'Loading your workspace',
		announce = true,
		children
	}: {
		header?: boolean;
		label?: string;
		announce?: boolean;
		children?: Snippet;
	} = $props();
	const route = $derived(describeRoute(page.route.id));
	const roleHint = useWorkspaceRole();
	const account = useAccount();
	const viewer = $derived(account?.());
	const role = $derived(viewer?.membership?.role ?? roleHint());
	const templateReady = $derived(viewer?.membership ? viewer.templateReady : undefined);
	const integration = $derived(findIntegrationDetails(page.params.slug ?? ''));
	const creationPending = $derived(route.document === 'new' && templateReady === true);
</script>

{#if announce && !creationPending}<span role="status" class="sr-only">{label}</span>{/if}
{#if header}
	<div
		class="flex h-[var(--app-nav-height)] items-center border-b-[length:var(--surface-border-width)] border-line bg-surface px-[3px] sm:px-[7px] md:px-[13px]"
		aria-hidden="true"
	>
		<div class="flex h-full shrink-0 items-stretch">
			{#each ['Contracts', ...(role === 'admin' ? ['Template', 'Integrations'] : []), 'Guides'] as label (label)}
				<div class="mr-[1.5px] flex items-stretch sm:mr-[11px]">
					<div class="flex items-center px-[5.5px] pt-0.5 text-[13px] leading-none">
						<SkeletonBlock>{label}</SkeletonBlock>
					</div>
					{#if label === 'Template'}
						<div class="flex w-5 items-center justify-center"><SkeletonBlock class="size-3" /></div>
					{/if}
				</div>
			{/each}
		</div>
		<SkeletonBlock class="ml-auto size-[25px] shrink-0 rounded-full" />
	</div>
{/if}
{#if route.requiresTemplate && templateReady === undefined}
	<div aria-hidden="true" class="mx-auto grid max-w-md gap-3 px-6 py-16">
		<SkeletonBlock class="h-6 w-48 max-w-full" />
		<SkeletonBlock class="h-4 w-full" />
	</div>
{:else if route.requiresTemplate && !templateReady}
	<TemplateSetupSkeleton {role} />
{:else if route.document === 'new'}
	<main inert aria-hidden="true" class="pointer-events-none pt-6 pb-12 blur-sm">
		<DocumentSkeleton embedded announce={false} />
	</main>
	<ContractCreationSkeleton {announce} {label} {children} onClose={() => goto('/contracts')} />
{:else if route.presentation === 'document'}
	<DocumentSkeleton template={route.document === 'template'} announce={false} />
{:else if route.presentation === 'contracts'}
	<ContractsSkeleton {role} announce={false} />
{:else if route.presentation === 'settings'}
	<SettingsSkeleton {role} />
{:else if route.presentation === 'contract-settings'}
	<ContractSettingsSkeleton />
{:else if route.presentation === 'team'}
	<TeamSkeleton {role} />
{:else if route.presentation === 'integrations'}
	<IntegrationCatalogSkeleton {role} />
{:else if route.presentation === 'guides'}
	<div aria-hidden="true" class="px-4 pt-8 pb-12 sm:px-6 md:px-8 md:pt-10">
		<div class="mx-auto max-w-[61.6rem]">
			<SkeletonBlock class="mb-6 w-fit text-lg font-medium md:mb-7">Guides</SkeletonBlock>
			<div class="grid gap-x-5 gap-y-12 md:grid-cols-2">
				{#each [0, 1, 2, 3] as item (item)}
					<div>
						<SkeletonBlock class="aspect-[1.91] w-full rounded-xl" />
						<SkeletonBlock class="mt-4 h-5 w-4/5" />
						<SkeletonBlock class="mt-1.5 h-5 w-full" />
						<SkeletonBlock class="mt-1 h-5 w-5/6" />
					</div>
				{/each}
			</div>
		</div>
	</div>
{:else if route.presentation === 'integration'}
	<div
		aria-hidden="true"
		class="min-h-[calc(100dvh-var(--app-header-height))] bg-page px-4 py-3.5 sm:px-6 md:px-8 md:py-4.5"
	>
		<div class="mx-auto max-w-[1200px]">
			<div class="mb-8 flex items-center gap-2 text-[12.5px]">
				<SkeletonBlock>{role === 'admin' ? 'Integrations' : 'Contracts'}</SkeletonBlock>
				<SkeletonBlock class="size-3" />
				<SkeletonBlock>{integration?.name ?? 'Integrations'}</SkeletonBlock>
			</div>
			{#if role && (role !== 'admin' || !integration)}
				<IntegrationAccessSkeleton />
			{:else if !role}
				<SkeletonBlock class="h-7 w-36" />
			{:else}
				<div class="border-b border-edge/50 pb-5 md:pb-6">
					<div class="flex flex-wrap items-start justify-between gap-4">
						<div class="min-w-0 flex-1 basis-80">
							<div class="flex items-center gap-3">
								<SkeletonBlock class="size-12 shrink-0 rounded-full" />
								<SkeletonBlock class="w-fit text-xl font-medium">{integration?.name}</SkeletonBlock>
							</div>
							<SkeletonBlock class="mt-3 w-fit text-[13px] leading-5.5"
								>{integration?.content.tagline}</SkeletonBlock
							>
						</div>
						<SkeletonBlock
							class="h-button-sm whitespace-nowrap rounded-button-lg px-[13px] py-[7.5px] text-[12.5px] font-normal md:ml-auto"
							>Install</SkeletonBlock
						>
					</div>
				</div>
				<div class="py-6">
					<div class="min-w-0 space-y-7 text-[13px] leading-5.5">
						{#if integration?.content.screenshots.length}
							<div class="flex gap-4 overflow-hidden">
								{#each integration.content.screenshots as screenshot (screenshot.src)}
									<div
										class="w-[85%] max-w-[760px] shrink-0 overflow-hidden rounded-xl border border-edge/50"
									>
										<SkeletonBlock class="aspect-[5/3] h-auto w-full rounded-none" />
									</div>
								{/each}
							</div>
						{/if}
						{#each integration?.content.sections ?? [] as section (section.key)}
							<div>
								<SkeletonBlock class="mb-3 w-fit text-base font-medium"
									>{section.title}</SkeletonBlock
								>
								{#each section.paragraphs as paragraph, index (index)}
									<SkeletonBlock class={index > 0 ? 'mt-3.5' : ''}>{paragraph}</SkeletonBlock>
								{/each}
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	</div>
{:else}
	<div aria-hidden="true" class="mx-auto grid max-w-md gap-5 px-6 py-16">
		<SkeletonBlock class="h-7 w-48" />
		<SkeletonBlock class="h-5 w-full" />
		<SkeletonBlock class="h-11 w-full rounded-lg" />
		<SkeletonBlock class="h-11 w-full rounded-lg" />
	</div>
{/if}
{#if children && !creationPending}
	<div
		class="fixed inset-x-3 bottom-4 z-50 mx-auto grid max-w-md justify-items-center gap-3 rounded-xl border-hairline border-edge bg-surface p-5 text-center shadow-floating"
	>
		{@render children()}
	</div>
{/if}
