<script lang="ts">
	import { getBuyerActivity } from './activity.svelte';
	import type { ActivityBrowser } from './tracking';

	import BuyerDocumentFrame from './BuyerDocumentFrame.svelte';
	import DocumentHeading from '$lib/components/document/DocumentHeading.svelte';
	import DocumentSection from '$lib/components/document/DocumentSection.svelte';
	import RouteTitle from '$lib/auth/RouteTitle.svelte';
	import { onMount, onDestroy, untrack, type Snippet } from 'svelte';

	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../convex/_generated/api';
	import type { Id } from '../../convex/_generated/dataModel';
	import { BuyerContract, setBuyerContract } from './contract.svelte';
	import { afterPaint } from '$lib/document/runtime/scheduler';
	import {
		recordColdStart,
		recordDocumentLoadingMilestone
	} from '$lib/document/runtime/render-perf';

	import Button from '$lib/ui/Button.svelte';
	import WorkspaceStatus from '$lib/components/chrome/WorkspaceStatus.svelte';
	import { setHeaderContent } from '$lib/components/chrome/header-content.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOutIcon';
	import { BuyerSeller, setBuyerSeller, type BuyerPageContext } from './seller.svelte';
	import type { HelpPolicy } from '$lib/components/ui/modal/help-session.svelte';
	import HelpModal from '$lib/components/ui/modal/HelpModal.svelte';
	let {
		token,
		templateVersionId,
		initialPageContext,
		children,
		browser = null,
		hasAccountSession = false
	}: {
		token: string;
		templateVersionId: Id<'templateVersions'>;
		initialPageContext?: BuyerPageContext;
		children: Snippet;
		browser?: ActivityBrowser;
		hasAccountSession?: boolean;
	} = $props();
	let menuOpen = $state(false);
	let menuButton = $state<HTMLButtonElement | null>(null);
	const header = setHeaderContent();
	const initialToken = untrack(() => token);
	const initialTemplateVersionId = untrack(() => templateVersionId);
	const activity = getBuyerActivity();
	const client = useConvexClient();
	const contract = setBuyerContract(
		new BuyerContract(initialToken, client, initialTemplateVersionId)
	);
	recordDocumentLoadingMilestone('help-opening-start', {
		opening: contract.help.loadingOpening
	});
	const seller = setBuyerSeller(
		new BuyerSeller(
			initialToken,
			untrack(() => initialPageContext)
		)
	);
	const headerReadiness = $derived(seller.headerReadiness);
	let firstPaintPassed = $state(false);
	let headerPresented = $state(false);
	const contractVisible = $derived(headerReadiness === 'ready' && headerPresented);
	$effect(() => {
		contract.headerPresented = contractVisible;
	});
	onMount(() => {
		const lifetime = new AbortController();
		void afterPaint(lifetime.signal)
			.then(() => (firstPaintPassed = true))
			.catch(() => {});
		return () => lifetime.abort();
	});
	$effect(() => {
		if (headerReadiness !== 'ready') {
			headerPresented = false;
			return;
		}
		if (headerPresented) return;
		// A header resolved before the first paint can reveal the document immediately.
		if (!firstPaintPassed) {
			headerPresented = true;
			return;
		}
		const lifetime = new AbortController();
		void afterPaint(lifetime.signal)
			.then(() => {
				if (seller.headerReadiness === 'ready') headerPresented = true;
			})
			.catch(() => {});
		return () => lifetime.abort();
	});
	// Buyer links always use manual buyer help (no automatic modal).
	$effect(() => {
		const phase = seller.phase;
		const identity = seller.accountIdentity;
		let policy: HelpPolicy = { kind: 'pending' };
		if (phase === 'buyer' || phase === 'preview') {
			policy = {
				kind: 'manual',
				variant: 'buyer-link-buyer',
				identity: `${phase}:${identity}`
			};
		}
		untrack(() => contract.help.configure(policy));
	});
	$effect(() => {
		if (seller.phase === 'preview') menuOpen = false;
	});
	onMount(() => seller.mount(hasAccountSession));
	onMount(() => activity?.setAccount(seller));
	onMount(() => {
		recordColdStart('buyer-entry-status-start');
		contract.warmCode();
		const update = () => {
			contract.connected = client.connectionState().isWebSocketConnected;
		};
		update();
		return client.subscribeToConnectionState(update);
	});
	const linkView = $derived(contract.linkSettled ? contract.linkState : initialPageContext);
	onMount(() => contract.mount());
	const headingPresentation = $derived.by(() => {
		if (headerReadiness !== 'ready' || contract.linkRejected || linkView?.kind !== 'current')
			return undefined;
		const current = linkView;
		if (seller.phase === 'preview')
			return { kind: 'preview' as const, buyerName: current.buyerName };
		if (seller.phase === 'buyer')
			return { kind: 'buyer' as const, companyName: current.companyName };
		return undefined;
	});
	$effect(() => {
		contract.buyerName = linkView?.kind === 'current' ? linkView.buyerName : null;
	});
	let mounted = false;
	let pendingRefresh: Promise<unknown> | undefined;
	let lastAcceptedAt = 0;
	function refreshBuyer() {
		if (
			!mounted ||
			linkView?.kind !== 'current' ||
			!linkView.buyerRefreshable ||
			contract.linkRejected ||
			document.visibilityState === 'hidden' ||
			pendingRefresh ||
			Date.now() - lastAcceptedAt < 45_000
		)
			return;
		const request = (pendingRefresh = client.mutation(api.hubspotRecipients.requestBuyer, {
			token: initialToken
		}));
		void request
			.then(() => {
				if (mounted) lastAcceptedAt = Date.now();
			})
			.catch(() => {})
			.finally(() => {
				if (pendingRefresh === request) pendingRefresh = undefined;
			});
	}
	onMount(() => {
		mounted = true;
		refreshBuyer();
		window.addEventListener('focus', refreshBuyer);
		document.addEventListener('visibilitychange', refreshBuyer);
		return () => {
			mounted = false;
			window.removeEventListener('focus', refreshBuyer);
			document.removeEventListener('visibilitychange', refreshBuyer);
		};
	});
	$effect(() => {
		if (linkView?.kind === 'current' && linkView.buyerRefreshable) untrack(refreshBuyer);
	});

	$effect(() => {
		const kind = linkView?.kind;
		const eligible = !contract.linkRejected && kind === 'current';
		const account = JSON.stringify([seller.accountIdentity, seller.identity]);
		untrack(() => {
			activity?.observe(initialToken, eligible, browser, account);
			contract.setAccess(eligible);
			contract.help.setActive(eligible);
		});
	});
	$effect(() => {
		if (!contract.allowed || !contract.help.resolved || contract.help.admitted) return;
		untrack(() => contract.help.considerAutomatic());
	});

	onDestroy(() => contract.destroy());
</script>

{#if seller.phase === 'preview'}
	<RouteTitle title="View contract as buyer" />
{:else if seller.phase === 'buyer'}
	<RouteTitle title="Review your contract" />
{/if}

<svelte:head>
	<meta name="robots" content="noindex,nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>
<header
	class="sticky top-0 left-0 z-40 border-b-[length:var(--surface-border-width)] border-line bg-surface"
	style:--app-header-height="var(--app-nav-height)"
>
	<div
		class="flex h-[calc(var(--app-nav-height)-var(--surface-border-width))] items-center justify-between gap-3 px-2 sm:px-3 md:px-[18.5px]"
	>
		{#if seller.phase === 'preview'}
			<p class="min-w-0 text-[13.5px] text-ink-muted">You are in buyer view.</p>
		{:else if seller.phase === 'buyer'}
			<p class="min-w-0 truncate text-[13.5px] text-ink-muted">
				Review your contract and leave comments
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
		{/if}
	</div>
</header>
{#if headerReadiness === 'pending'}
	<span role="status" class="sr-only">Opening contract</span>
{/if}
{#if header.content}
	<WorkspaceStatus announcement={null}>{@render header.content()}</WorkspaceStatus>
{/if}
{#if contractVisible && contract.allowed && contract.help.open}
	<HelpModal help={contract.help} onClose={() => contract.help.close()} />
{/if}
{#if headerReadiness === 'unavailable'}
	<main class="mx-auto max-w-md px-6 py-16 text-center">
		<h1 class="text-lg font-medium">Couldn’t check your account</h1>
		<p class="mt-3 text-sm text-ink-muted">Please try again to open this contract.</p>
		<Button variant="secondary" class="mt-5" onclick={() => seller.retry()}>Try again</Button>
	</main>
{:else if !contract.linkRejected && linkView?.kind === 'current'}
	<DocumentSection active={contractVisible}>
		{#snippet heading()}
			{#if contract.refreshError}<p role="alert" class="p-4 text-center text-sm">
					{contract.refreshError}
					<button class="underline" onclick={() => contract.retryDocument()}>Try again</button>
				</p>{/if}
			{#if contract.linkError}<p role="alert" class="p-4 text-center text-sm">
					We couldn’t refresh link access. <button
						class="underline"
						onclick={() => contract.retryLink()}>Try again</button
					>
				</p>{/if}
			{#if contractVisible}<DocumentHeading
					kind="buyer"
					buyerPresentation={headingPresentation}
				/>{/if}
		{/snippet}
		<div class:invisible={!contractVisible} aria-hidden={!contractVisible} inert={!contractVisible}>
			{@render children()}
		</div>
	</DocumentSection>
{:else if linkView?.kind === 'unavailable' || contract.linkError}
	<main class="mx-auto max-w-md px-6 py-16 text-center">
		<h1 class="text-lg font-medium">Link unavailable</h1>
		<p class="mt-3 text-sm text-ink-muted">
			We couldn’t open this contract. Check your connection or ask your rep for help.
		</p>
		<Button variant="secondary" class="mt-5" onclick={() => contract.retryLink()}>Try again</Button>
	</main>
{:else}
	{#if contractVisible}
		<DocumentSection>
			{#snippet heading()}<DocumentHeading kind="buyer" />{/snippet}
			<BuyerDocumentFrame loading />
		</DocumentSection>
	{/if}
{/if}
