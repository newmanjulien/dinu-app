<script lang="ts">
	import { page } from '$app/state';
	import { loginHref, currentDestination } from '$lib/auth/navigation';
	import { getBuyerActivity } from './activity.svelte';
	import type { ActivityBrowser } from './tracking';

	import BuyerDocumentFrame from './BuyerDocumentFrame.svelte';
	import { useReadQuery } from '$lib/auth/read-query.svelte';
	import RouteTitle from '$lib/auth/RouteTitle.svelte';
	import { onMount, onDestroy, untrack, type Snippet } from 'svelte';

	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../convex/_generated/api';
	import { BuyerContract, setBuyerContract } from './contract.svelte';
	import { recordColdStart } from '$lib/document/runtime/render-perf';

	import Button from '$lib/ui/Button.svelte';
	import WorkspaceStatus from '$lib/components/chrome/WorkspaceStatus.svelte';
	import { setHeaderContent } from '$lib/components/chrome/header-content.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOutIcon';
	import AccountMenu from '$lib/components/chrome/AccountMenu.svelte';
	import { BuyerSeller, setBuyerSeller } from './seller.svelte';
	import type { HelpPolicy } from '$lib/components/ui/modal/help-session.svelte';
	import { isBuyerHelpHidden, setBuyerHelpHidden } from '$lib/components/ui/modal/help-storage';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	let {
		token,
		children,
		browser = null,
		hasAccountSession = false
	}: {
		token: string;
		children: Snippet;
		browser?: ActivityBrowser;
		hasAccountSession?: boolean;
	} = $props();
	let menuOpen = $state(false);
	let menuButton = $state<HTMLButtonElement | null>(null);
	const header = setHeaderContent();
	const initialToken = untrack(() => token);
	const activity = getBuyerActivity();
	const client = useConvexClient();
	const contract = setBuyerContract(new BuyerContract(initialToken, client));
	const seller = setBuyerSeller(new BuyerSeller(initialToken));
	// Help belongs to the shell, outside the document's keyed renderer lifetime.
	$effect(() => {
		const presentation = seller.presentation;
		const account = seller.accountIdentity;
		const viewer = seller.viewer;
		const sellerClient = seller.client;
		const buyerIdentity = seller.recoveryIdentity;
		const scope = page.data.buyerPreferenceScope;
		let policy: HelpPolicy = { kind: 'pending' };
		if (viewer && sellerClient && (presentation === 'seller' || presentation === 'preview')) {
			const identity = viewer.profile.id;
			policy =
				presentation === 'preview'
					? { kind: 'preview', identity }
					: {
							kind: 'preference',
							confirmation: 'subscription',
							identity,
							hidden: viewer.helpPreferences.buyer,
							save: (hidden) =>
								sellerClient.mutation(api.profiles.setHelpHidden, { variant: 'buyer', hidden }),
							current: () =>
								seller.viewer?.profile.id === identity &&
								seller.client === sellerClient &&
								seller.accountIdentity === account
						};
		} else if (presentation === 'buyer' && scope) {
			policy = {
				kind: 'preference',
				confirmation: 'save',
				identity: `buyer:${buyerIdentity}`,
				hidden: untrack(() => isBuyerHelpHidden(scope)),
				save: async (hidden) => setBuyerHelpHidden(scope, hidden),
				current: () => seller.phase === 'buyer' && seller.accountIdentity === account
			};
		}
		untrack(() => contract.help.configure(policy));
	});
	const commentRecipient = $derived(contract.buyerName);
	const pageTitle = $derived.by(() => {
		if (seller.presentation === 'checking' || seller.presentation === 'unavailable')
			return 'Contract';
		if (seller.presentation === 'buyer') return 'Review your contract';
		if (seller.preview) return 'View contract as buyer';
		return commentRecipient ? `Leave comments for ${commentRecipient}` : 'Leave comments';
	});
	$effect(() => {
		if (seller.viewer) menuOpen = false;
	});
	function toggleBuyerPreview() {
		if (seller.preview) seller.preview = false;
		else seller.viewAsBuyer();
	}
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
	const status = useReadQuery(api.buyerLinks.status, { token: initialToken });
	$effect(() => {
		contract.buyerName = status.data?.kind === 'current' ? status.data.buyerName : null;
	});
	onMount(() => {
		const lifetime = new AbortController();
		let pending: Promise<Response> | undefined;
		const refresh = () => {
			if (document.visibilityState === 'hidden' || pending) return;
			const request = (pending = fetch('/api/buyer/name', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: initialToken }),
				signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(12_000)])
			}));
			void request
				.catch(() => {})
				.finally(() => {
					if (pending === request) pending = undefined;
				});
		};
		refresh();
		window.addEventListener('focus', refresh);
		document.addEventListener('visibilitychange', refresh);
		return () => {
			lifetime.abort();
			window.removeEventListener('focus', refresh);
			document.removeEventListener('visibilitychange', refresh);
		};
	});
	const documentHeading = $derived.by(() => {
		if (status.data?.kind !== 'current') return null;
		if (seller.presentation === 'checking' || seller.presentation === 'unavailable') return null;
		if (seller.presentation === 'buyer')
			return `Contract you will sign with ${status.data.companyName}`;
		const recipient = commentRecipient || 'the buyer';
		return seller.preview
			? `Buyer preview · This is how the contract appears to ${recipient}`
			: null;
	});
	$effect(() => {
		const kind = status.data?.kind;
		const eligible = !status.rejected && kind === 'current';
		const account = JSON.stringify([seller.accountIdentity, seller.identity]);
		untrack(() => {
			activity?.observe(initialToken, eligible, browser, account);
			contract.setAccess(eligible);
		});
	});

	onDestroy(() => contract.destroy());
</script>

<RouteTitle title={pageTitle} />

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
		{#if (seller.presentation === 'seller' || seller.presentation === 'preview') && seller.viewer}
			<p class="text-[13.5px] text-ink-muted">
				{#if seller.preview}You are in buyer view.{/if}
				<button
					type="button"
					class="cursor-pointer text-accent underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:text-ink-muted"
					onclick={toggleBuyerPreview}
				>
					{seller.preview ? 'Back to your view' : 'View as buyer'}
				</button>
			</p>
			{#if !seller.preview}
				<AccountMenu profile={seller.viewer.profile} onSignOut={() => seller.signOut()} />
			{/if}
		{:else if seller.presentation === 'buyer'}
			<p class="min-w-0 truncate text-[13.5px] text-ink-muted">
				{#if page.url.searchParams.get('review') === '1'}<a
						class="text-accent underline"
						href={loginHref(currentDestination(page.url))}>Sign in to review buyer changes</a
					>
				{:else}Review your contract and leave comments{/if}
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
		{:else}
			<p class="text-[13.5px] text-ink-muted">
				{seller.presentation === 'checking' ? 'Opening contract…' : 'Contract'}
			</p>
		{/if}
	</div>
</header>
{#if header.content}
	<WorkspaceStatus announcement={null}>{@render header.content()}</WorkspaceStatus>
{/if}
{#snippet heading()}
	<div
		class="mt-2 mb-2 grid min-h-(--mobile-utility-rail-height) place-items-center px-2 text-center text-[13.5px] leading-6 text-ink-muted min-[1000px]:mt-5 min-[1000px]:mb-4 min-[1000px]:min-h-6"
	>
		{#if documentHeading}
			<h1>{documentHeading}</h1>
		{:else}
			<SkeletonBlock class="h-3 w-52" />
		{/if}
	</div>
{/snippet}
{#if !status.rejected && status.data?.kind === 'current'}
	{#if contract.refreshError}<p role="alert" class="p-4 text-center text-sm">
			{contract.refreshError}
			<button class="underline" onclick={() => contract.retryDocument()}>Try again</button>
		</p>{/if}
	{#if status.error}<p role="alert" class="p-4 text-center text-sm">
			We couldn’t refresh link access. <button class="underline" onclick={() => status.retry()}
				>Try again</button
			>
		</p>{/if}
	{#if seller.presentation !== 'seller'}{@render heading()}{/if}
	{@render children()}
{:else if status.data?.kind === 'unavailable' || status.error}
	<main class="mx-auto max-w-md px-6 py-16 text-center">
		<h1 class="text-lg font-medium">Link unavailable</h1>
		<p class="mt-3 text-sm text-ink-muted">
			We couldn’t open this contract. Check your connection or ask for the latest link.
		</p>
		<Button variant="secondary" class="mt-5" onclick={() => status.retry()}>Try again</Button>
	</main>
{:else}
	{@render heading()}
	<BuyerDocumentFrame loading />
{/if}
