<script lang="ts">
	import { orderedTools, type ToolStates } from '$lib/components/document/document-tools';
	import RailTool from './RailTool.svelte';
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';
	import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
	import GearIcon from 'phosphor-svelte/lib/GearIcon';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
	import { protectedInteraction } from '$lib/components/ui/interactions';
	const protect = protectedInteraction();

	let {
		states,
		interactionOwner,
		searchOpen = false,
		searchEnabled = true,
		helpEnabled = true,
		helpLabel = 'How Dinu works',
		desktopElement = $bindable(),
		mobileElement = $bindable(),
		onSearchToggle,
		onOpenHelp,
		onDownload,
		downloadReason = null,
		settingsHref
	}: {
		states?: ToolStates;
		interactionOwner?: symbol;
		searchOpen?: boolean;
		searchEnabled?: boolean;
		helpEnabled?: boolean;
		helpLabel?: string;
		desktopElement?: HTMLElement;
		mobileElement?: HTMLElement;
		onSearchToggle?: (trigger: HTMLButtonElement) => void;
		onOpenHelp?: () => void;
		onDownload?: () => void;
		downloadReason?: string | null;
		settingsHref?: string;
	} = $props();
	const resolved = $derived<ToolStates>(
		states ?? {
			search: {
				applicability: onSearchToggle ? 'present' : 'absent',
				display: 'ready',
				enabled: searchEnabled
			},
			download: {
				applicability: onDownload ? 'present' : 'absent',
				display: 'ready',
				enabled: !downloadReason
			},
			settings: {
				applicability: settingsHref ? 'present' : 'absent',
				display: 'ready',
				enabled: true
			},
			help: {
				applicability: onOpenHelp ? 'present' : 'absent',
				display: 'ready',
				enabled: helpEnabled
			}
		}
	);
	const visible = $derived(orderedTools(resolved));
</script>

{#snippet commonTools()}
	{#if visible.has('download')}
		<RailTool
			label={resolved.download.display === 'failed'
				? 'Retry download availability'
				: downloadReason
					? `Download document as .docx: ${downloadReason}`
					: 'Download document as .docx'}
			caption="Download"
			aria-disabled={resolved.download.display !== 'failed' &&
				(!resolved.download.enabled || Boolean(downloadReason))}
			onclick={() => {
				if (resolved.download.display === 'failed') resolved.download.retry?.();
				else if (resolved.download.enabled && !downloadReason) onDownload?.();
			}}
		>
			<DownloadSimpleIcon class="size-5 min-[1000px]:size-[18px]" aria-hidden="true" />
		</RailTool>
	{/if}
	{#if visible.has('settings')}
		<RailTool
			href={resolved.settings.display === 'failed' ? undefined : settingsHref}
			label={resolved.settings.display === 'failed'
				? 'Retry contract settings'
				: 'Contract settings'}
			caption="Settings"
			disabled={resolved.settings.display !== 'failed' && !resolved.settings.enabled}
			onclick={() => resolved.settings.retry?.()}
		>
			<GearIcon aria-hidden="true" class="size-[19px] min-[1000px]:size-[18px]" weight="regular" />
		</RailTool>
	{/if}
	{#if visible.has('help')}
		<RailTool
			label={helpLabel}
			caption="Help"
			disabled={!resolved.help.enabled}
			onclick={onOpenHelp}
		>
			<InfoIcon aria-hidden="true" class="size-[19px] min-[1000px]:size-[18px]" weight="regular" />
		</RailTool>
	{/if}
{/snippet}

<nav
	use:protect={interactionOwner ?? true}
	bind:this={mobileElement}
	class="fixed top-[calc(var(--app-header-height)+8px)] left-2 z-20 flex gap-1 rounded-lg border-hairline border-edge bg-surface shadow-floating min-[1000px]:hidden"
	aria-label="Document tools"
>
	{#if visible.has('search')}
		<RailTool
			label={resolved.search.display === 'failed' ? 'Retry document search' : 'Search document'}
			caption="Search"
			disabled={resolved.search.display !== 'failed' && !resolved.search.enabled}
			aria-pressed={searchOpen}
			aria-controls="document-search"
			onclick={(event) => {
				if (resolved.search.display === 'failed') resolved.search.retry?.();
				else onSearchToggle?.(event.currentTarget);
			}}
		>
			<MagnifyingGlassIcon
				aria-hidden="true"
				class="size-[19px] min-[1000px]:size-[18px]"
				weight="regular"
			/>
		</RailTool>
	{/if}
	{@render commonTools()}
</nav>

<div
	use:protect={interactionOwner ?? true}
	bind:this={desktopElement}
	class="pointer-events-none fixed top-[calc(var(--app-header-height)+14px)] left-1 z-15 max-[999px]:hidden"
>
	<nav class="pointer-events-none flex w-16 flex-col items-center" aria-label="Document tools">
		<div class="pointer-events-auto flex flex-col items-center gap-3.5">
			{#if visible.has('search')}
				<RailTool
					label={resolved.search.display === 'failed' ? 'Retry document search' : 'Search document'}
					caption="Search"
					disabled={resolved.search.display !== 'failed' && !resolved.search.enabled}
					aria-pressed={searchOpen}
					aria-controls="document-search"
					onclick={(event) => {
						if (resolved.search.display === 'failed') resolved.search.retry?.();
						else onSearchToggle?.(event.currentTarget);
					}}
				>
					<MagnifyingGlassIcon
						aria-hidden="true"
						class="size-[19px] min-[1000px]:size-[18px]"
						weight="regular"
					/>
				</RailTool>
			{/if}
			{@render commonTools()}
		</div>
	</nav>
</div>
