<script lang="ts">
	import RailTool from './RailTool.svelte';
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';
	import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
	import GearIcon from 'phosphor-svelte/lib/GearIcon';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
	import { protectedInteraction } from '$lib/components/ui/interactions';
	const protect = protectedInteraction();

	let {
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
</script>

{#snippet commonTools()}
	{#if onDownload}
		<RailTool
			label={downloadReason
				? `Download document as .docx: ${downloadReason}`
				: 'Download document as .docx'}
			caption="Download"
			aria-disabled={Boolean(downloadReason)}
			onclick={() => {
				if (!downloadReason) onDownload?.();
			}}
		>
			<DownloadSimpleIcon class="size-5 min-[1000px]:size-[18px]" aria-hidden="true" />
		</RailTool>
	{/if}
	{#if settingsHref}
		<RailTool href={settingsHref} label="Contract settings" caption="Settings">
			<GearIcon aria-hidden="true" class="size-[19px] min-[1000px]:size-[18px]" weight="regular" />
		</RailTool>
	{/if}
	{#if onOpenHelp}
		<RailTool label={helpLabel} caption="Help" disabled={!helpEnabled} onclick={onOpenHelp}>
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
	{#if onSearchToggle}
		<RailTool
			label="Search document"
			caption="Search"
			disabled={!searchEnabled}
			aria-pressed={searchOpen}
			aria-controls="document-search"
			onclick={(event) => onSearchToggle?.(event.currentTarget)}
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
			{#if onSearchToggle}
				<RailTool
					label="Search document"
					caption="Search"
					disabled={!searchEnabled}
					aria-pressed={searchOpen}
					aria-controls="document-search"
					onclick={(event) => onSearchToggle?.(event.currentTarget)}
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
