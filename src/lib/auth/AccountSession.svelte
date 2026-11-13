<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { useClerkContext } from 'svelte-clerk';
	import { setAccountContext } from './account-context.svelte';
	import { setAccount } from './viewer-session.svelte';
	import { useViewerSession } from './viewer-session.svelte';
	import { loadComponent } from './component-loader.svelte';
	import { preloadDestination } from './destination-code';
	import { useStartupPreparation } from './startup-preparation';
	import { useStartupData } from './startup-data';
	import { WorkspaceHints, setWorkspaceHints } from './workspace-hints.svelte';
	import { onDestroy, untrack, type Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
	const session = useViewerSession();
	const clerk = useClerkContext();
	const owner = setAccountContext();
	setAccount(() => (owner.identity === identity ? (owner.account ?? undefined) : undefined));
	const hints = new WorkspaceHints();
	const startup = useStartupData();
	session.registerResources(hints);
	setWorkspaceHints({
		get role() {
			if (session.closing) return undefined;
			return workspaceViewer !== undefined
				? workspaceViewer?.membership?.role
				: hints.roleFor(userId, identity);
		},
		get templateReady() {
			if (session.closing) return undefined;
			return workspaceViewer !== undefined
				? workspaceViewer?.membership
					? workspaceViewer.templateReady
					: undefined
				: hints.templateReadyFor(userId, identity);
		},
		get hasBuyerLinks() {
			const membership = workspaceViewer?.membership;
			if (session.closing || (workspaceViewer !== undefined && !membership)) return undefined;
			return hints.buyerLinksFor(
				userId,
				identity,
				membership ? { membershipId: membership.id, companyId: membership.companyId } : undefined
			);
		},
		rememberBuyerLinks(scope, present) {
			const viewer = workspaceViewer;
			const membership = viewer?.membership;
			if (
				session.closing ||
				!viewer ||
				!userId ||
				!identity ||
				membership?.id !== scope.membershipId ||
				membership.companyId !== scope.companyId
			)
				return;
			hints.rememberBuyerLinks(
				userId,
				identity,
				{ ...scope, role: membership.role, templateReady: viewer.templateReady },
				present
			);
		}
	});
	const preparation = useStartupPreparation();
	const identity = $derived(clerk.auth.sessionId ?? clerk.session?.id);
	const userId = $derived(clerk.auth.userId ?? clerk.user?.id);
	const workspaceViewer = $derived(
		owner.identity === identity && owner.account !== undefined ? owner.account : startup()?.viewer
	);
	const required = $derived(!['/login', '/join'].includes(page.url.pathname));
	const workspaceRoute = $derived(page.route.id?.startsWith('/(workspace)') ?? false);
	const account = loadComponent(
		() => import('./AuthenticatedAccount.svelte'),
		() => browser && (workspaceRoute || Boolean(identity)),
		() => session.transportGeneration
	);
	const AuthenticatedAccount = $derived(account.component);
	$effect(() => {
		const active = clerk.session;
		const user = userId;
		const closing = session.closing;
		const generation = session.transportGeneration;
		const value = workspaceViewer;
		if (!browser) return;
		untrack(() => {
			if (!active || active.id !== identity || !user || closing) hints.clear();
			else if (value !== undefined)
				hints.confirm(
					user,
					active.id,
					value?.membership
						? {
								membershipId: value.membership.id,
								companyId: value.membership.companyId,
								role: value.membership.role,
								templateReady: value.templateReady
							}
						: null
				);
			else
				hints.prepare(user, active.id, generation, () => active.getToken({ template: 'convex' }));
		});
	});
	onDestroy(() => hints.clear());
	$effect(() => {
		if (!browser) return;
		if (account.failed || (clerk.isLoaded && !identity)) preparation.cancel();
		else if (workspaceRoute && !AuthenticatedAccount) preparation.warm();
	});
	$effect(() => {
		if (browser && required && (workspaceRoute || identity))
			void preloadDestination(page.url.pathname).catch(() => {});
	});
</script>

{@render children()}
{#if browser && identity && session.preparedSessionId === identity && !session.closing && AuthenticatedAccount}
	{#key identity}<AuthenticatedAccount />{/key}
{/if}
{#if account.failed && required && identity}
	<div role="alert" class="fixed inset-x-0 bottom-0 z-50 bg-white p-4 text-center text-sm">
		We couldn’t load your account. Please try again.
		<button class="underline" onclick={() => account.retry()}>Try again</button>
		<button class="ml-4 underline" onclick={() => void session.signOut()}>Log out</button>
	</div>
{/if}
