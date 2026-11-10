<script lang="ts">
	import DownloadTool from './DownloadTool.svelte';
	import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
	import GearIcon from 'phosphor-svelte/lib/GearIcon';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import { protectedInteraction } from '$lib/components/ui/interactions';
	const protect = protectedInteraction();

	let {
		searchOpen = false,
		searchEnabled = true,
		helpEnabled = true,
		helpLabel = 'Help: How Dinu works',
		desktopElement = $bindable(),
		desktopSearchElement = $bindable(),
		mobileSearchElement = $bindable(),
		onSearchToggle,
		onOpenHelp,
		onDownload,
		downloadReason = null,
		settingsHref
	}: {
		searchOpen?: boolean;
		searchEnabled?: boolean;
		helpEnabled?: boolean;
		helpLabel?: string;
		desktopElement?: HTMLElement;
		desktopSearchElement?: HTMLButtonElement | null;
		mobileSearchElement?: HTMLButtonElement | null;
		onSearchToggle?: (trigger: HTMLButtonElement) => void;
		onOpenHelp?: () => void;
		onDownload?: () => void;
		downloadReason?: string | null;
		settingsHref?: string;
	} = $props();
</script>

<nav
	use:protect
	class="fixed top-[calc(var(--app-header-height)+8px)] left-2 z-20 flex gap-1 rounded-lg border-hairline border-edge bg-surface shadow-floating min-[1000px]:hidden"
	aria-label="Document tools"
>
	{#if onSearchToggle}
		<SquareIconButton
			bind:element={mobileSearchElement}
			class="rounded-button-lg"
			type="button"
			disabled={!searchEnabled}
			aria-label="Search document"
			aria-pressed={searchOpen}
			aria-controls="document-search"
			onclick={() => mobileSearchElement && onSearchToggle?.(mobileSearchElement)}
		>
			<MagnifyingGlassIcon aria-hidden="true" class="size-[19px]" weight="regular" />
		</SquareIconButton>
	{/if}
	{#if onDownload}<DownloadTool reason={downloadReason} {onDownload} />{/if}
	{#if onOpenHelp}
		<SquareIconButton
			class="rounded-button-lg"
			type="button"
			disabled={!helpEnabled}
			aria-label={helpLabel}
			onclick={onOpenHelp}
			><InfoIcon aria-hidden="true" class="size-[19px]" weight="regular" /></SquareIconButton
		>
	{/if}
	{#if settingsHref}
		<a
			href={settingsHref}
			aria-label="Contract settings"
			class="grid size-[35px] place-items-center rounded-button-lg text-ink-secondary hover:bg-control-hover focus-visible:bg-control-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
		>
			<GearIcon aria-hidden="true" class="size-[19px]" weight="regular" />
		</a>
	{/if}
</nav>

<div
	use:protect
	bind:this={desktopElement}
	class="pointer-events-none fixed top-[calc(var(--app-header-height)+14px)] left-1 z-15 max-[999px]:hidden"
>
	<nav class="pointer-events-none flex w-16 flex-col items-center" aria-label="Document tools">
		<div class="pointer-events-auto flex flex-col items-center gap-3.5">
			{#if onSearchToggle}
				<div
					class="flex flex-col items-center gap-[3px] text-[9px] leading-[1.2] text-ink-secondary"
				>
					<SquareIconButton
						bind:element={desktopSearchElement}
						class="size-8 rounded-button-lg"
						type="button"
						disabled={!searchEnabled}
						aria-label="Search"
						aria-pressed={searchOpen}
						aria-controls="document-search"
						onclick={() => desktopSearchElement && onSearchToggle?.(desktopSearchElement)}
					>
						<MagnifyingGlassIcon aria-hidden="true" class="size-[18px]" weight="regular" />
					</SquareIconButton>
					<span aria-hidden="true">Search</span>
				</div>
			{/if}
			{#if onDownload}
				<div
					class="flex flex-col items-center gap-[3px] text-[9px] leading-[1.2] text-ink-secondary"
				>
					<DownloadTool reason={downloadReason} {onDownload} />
					<span aria-hidden="true" class="max-w-16 text-center">Download</span>
				</div>
			{/if}
			{#if onOpenHelp}
				<div
					class="flex flex-col items-center gap-[3px] text-[9px] leading-[1.2] text-ink-secondary"
				>
					<SquareIconButton
						class="size-8 rounded-button-lg"
						type="button"
						disabled={!helpEnabled}
						aria-label={helpLabel}
						onclick={onOpenHelp}
					>
						<InfoIcon aria-hidden="true" class="size-[18px]" weight="regular" />
					</SquareIconButton>
					<span aria-hidden="true">Help</span>
				</div>
			{/if}
			{#if settingsHref}
				<a
					href={settingsHref}
					aria-label="Contract settings"
					class="flex flex-col items-center gap-[3px] rounded-button-lg text-[9px] leading-[1.2] text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
				>
					<span class="grid size-8 place-items-center rounded-button-lg hover:bg-control-hover">
						<GearIcon aria-hidden="true" class="size-[18px]" weight="regular" />
					</span>
					<span aria-hidden="true">Settings</span>
				</a>
			{/if}
		</div>
	</nav>
</div>
