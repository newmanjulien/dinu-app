<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { useAccount, useViewerSession, type Viewer } from './viewer-session.svelte';
	import { currentDestination, onboardingHref, localReturn } from './navigation';
	import WorkspaceScope from './WorkspaceScope.svelte';
	import WorkspaceShell from './WorkspaceShell.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import WorkspaceSkeleton from './WorkspaceSkeleton.svelte';
	import { loadComponent } from './component-loader.svelte';
	import { untrack, type Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
	const account = useAccount();
	const session = useViewerSession();
	const member = $derived.by((): Viewer | undefined => {
		const value = account();
		return value?.membership && value.company
			? { ...value, membership: value.membership, company: value.company }
			: undefined;
	});
	const workspace = loadComponent(
		() => import('./Workspace.svelte'),
		() => true,
		() => session.transportGeneration
	);
	const Workspace = $derived(workspace.component);
	let navigationError = $state('');
	const error = $derived(
		navigationError || (workspace.failed ? 'We couldn’t load your workspace.' : '')
	);
	let retry = $state(0);
	$effect(() => {
		void retry;
		const value = member;
		const returning = page.url.pathname === '/team' ? page.url.searchParams.get('returnTo') : null;
		const destination = returning ? localReturn(returning) : currentDestination(page.url);
		if (!value)
			untrack(() => {
				navigationError = '';
				void goto(
					new URL(destination, page.url).pathname === '/invitation'
						? destination
						: onboardingHref(destination),
					{ replaceState: true }
				).catch(() => {
					navigationError = 'We couldn’t open company setup. Please try again.';
				});
			});
	});
</script>

{#snippet pending()}
	{#if member && !error}
		<WorkspaceSkeleton label="Opening your workspace" />
	{:else}
		<main class="bg-page">
			<LoadingState
				layout={member ? 'workspace' : 'screen'}
				label={error ? undefined : 'Opening your workspace'}
			>
				{#if error}
					<p role="alert" class="text-sm">{error}</p>
					<button
						class="text-sm underline"
						onclick={() => {
							retry++;
							workspace.retry();
						}}>Try again</button
					>
				{/if}
			</LoadingState>
		</main>
	{/if}
{/snippet}
{#if member}
	{#key `${member.profile.id}:${member.membership.id}`}
		<WorkspaceScope viewer={member}>
			<WorkspaceShell>
				{#if Workspace}<Workspace>{@render children()}</Workspace>{:else}{@render pending()}{/if}
			</WorkspaceShell>
		</WorkspaceScope>
	{/key}
{:else}{@render pending()}{/if}
