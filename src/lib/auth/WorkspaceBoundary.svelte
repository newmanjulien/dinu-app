<script lang="ts">
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { useAccount, type Viewer } from './viewer-session.svelte';
	import { currentDestination, onboardingHref, localReturn } from './navigation';
	import WorkspaceScope from './WorkspaceScope.svelte';
	import WorkspaceShell from './WorkspaceShell.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import Workspace from './Workspace.svelte';
	import { untrack, type Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
	const account = useAccount();
	const member = $derived.by((): Viewer | undefined => {
		const value = account();
		return value?.membership && value.company
			? { ...value, membership: value.membership, company: value.company }
			: undefined;
	});
	let navigationError = $state('');
	const error = $derived(navigationError);
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
	<WorkspacePresentationReporter outcome={error ? 'error' : 'pending'} revision={retry} />
	<main class="bg-page">
		<LoadingState layout="screen" label={error ? undefined : 'Opening your workspace'}>
			{#if error}
				<p role="alert" class="text-sm">{error}</p>
				<button class="text-sm underline" onclick={() => retry++}>Try again</button>
			{/if}
		</LoadingState>
	</main>
{/snippet}
{#if member}
	{#key `${member.profile.id}:${member.membership.id}:${member.company.id}`}
		<WorkspaceScope viewer={member}>
			<WorkspaceShell>
				<Workspace>{@render children()}</Workspace>
			</WorkspaceShell>
		</WorkspaceScope>
	{/key}
{:else}{@render pending()}{/if}
