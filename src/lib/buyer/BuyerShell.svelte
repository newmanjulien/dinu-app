<script lang="ts">
	import { getBuyerActivity } from './activity.svelte';
	import type { ActivityBrowser } from './tracking';

	import BuyerDocumentFrame from './BuyerDocumentFrame.svelte';
	import { useReadQuery } from '$lib/auth/read-query.svelte';
	import { onMount, onDestroy, untrack, type Snippet } from 'svelte';

	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../convex/_generated/api';
	import { BuyerContract, setBuyerContract } from './contract.svelte';

	import Button from '$lib/ui/Button.svelte';
	import WorkspaceStatus from '$lib/components/chrome/WorkspaceStatus.svelte';
	import { setHeaderContent } from '$lib/components/chrome/header-content.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOutIcon';
	let {
		token,
		children,
		browser = null
	}: { token: string; children: Snippet; browser?: ActivityBrowser } = $props();
	let menuOpen = $state(false);
	let menuButton = $state<HTMLButtonElement | null>(null);
	const header = setHeaderContent();
	const initialToken = untrack(() => token);
	const activity = getBuyerActivity();
	const client = useConvexClient();
	const contract = setBuyerContract(new BuyerContract(initialToken, client));
	const status = useReadQuery(api.buyerLinks.status, { token: initialToken });
	$effect(() => {
		const kind = status.data?.kind;
		const eligible = !status.rejected && kind === 'current';
		untrack(() => {
			activity?.observe(initialToken, eligible, browser);
			contract.setAccess(eligible);
		});
	});
	onMount(() => {
		const update = () => {
			contract.connected = client.connectionState().isWebSocketConnected;
		};
		update();
		return client.subscribeToConnectionState(update);
	});
	onDestroy(() => contract.destroy());
</script>

<svelte:head>
	<meta name="robots" content="noindex,nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>
<header
	class="sticky top-0 z-40 border-b-[length:var(--surface-border-width)] border-line bg-surface"
	style:--app-header-height="var(--app-nav-height)"
>
	<div
		class="flex h-[calc(var(--app-nav-height)-var(--surface-border-width))] items-center justify-between gap-3 px-2 sm:px-3 md:px-[18.5px]"
	>
		<p class="min-w-0 truncate text-[12px] leading-tight text-ink-secondary sm:text-[13px]">
			{#if !status.rejected && status.data?.kind === 'current'}
				{status.data.title}
			{:else}
				Review your contract and leave comments
			{/if}
		</p>
		<SquareIconButton
			bind:element={menuButton}
			type="button"
			class="size-[25px] shrink-0"
			aria-label="Agreement options"
			aria-haspopup="menu"
			aria-expanded={menuOpen}
			aria-controls="buyer-options-menu"
			onclick={() => (menuOpen = !menuOpen)}
			onkeydown={(event) => {
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					event.preventDefault();
					menuOpen = true;
				}
			}}
		>
			<DotsThreeVerticalIcon class="size-[17px]" weight="bold" aria-hidden="true" />
		</SquareIconButton>
		<Menu
			open={menuOpen}
			trigger={menuButton ?? undefined}
			onClose={() => (menuOpen = false)}
			id="buyer-options-menu"
			label="Agreement options"
		>
			{#snippet children(close)}
				<MenuItem onclick={close}>
					About Dinu
					<ArrowSquareOutIcon class="size-[15px] shrink-0" aria-hidden="true" />
				</MenuItem>
			{/snippet}
		</Menu>
	</div>
</header>
{#if header.content}
	<WorkspaceStatus announcement={null}>{@render header.content()}</WorkspaceStatus>
{/if}
{#if !status.rejected && status.data?.kind === 'current'}
	{#if contract.publicationError}<p role="alert" class="p-4 text-center text-sm">
			{contract.publicationError}
			<button class="underline" onclick={() => contract.retryPublication()}>Try again</button>
		</p>{/if}
	{#if status.error}<p role="alert" class="p-4 text-center text-sm">
			We couldn’t refresh link access. <button class="underline" onclick={() => status.retry()}
				>Try again</button
			>
		</p>{/if}
	{@render children()}
	{#key contract.generation}
		{@const generation = contract.generation}
		<svelte:boundary onerror={() => untrack(() => contract.fail(generation, 'construction'))}>
			{#if contract.allowed && contract.mountReady && contract.Host && contract.content}
				<contract.Host {contract} />
			{/if}
			{#snippet failed()}{/snippet}
		</svelte:boundary>
	{/key}
{:else if status.data?.kind === 'unavailable' || status.error}
	<main class="mx-auto max-w-md px-6 py-16 text-center">
		<h1 class="text-lg font-medium">Link unavailable</h1>
		<p class="mt-3 text-sm text-ink-muted">
			We couldn’t open this contract. Check your connection or ask for the latest link.
		</p>
		<Button variant="secondary" class="mt-5" onclick={() => status.retry()}>Try again</Button>
	</main>
{:else}
	<BuyerDocumentFrame loading />
{/if}
