<script lang="ts">
	import { page } from '$app/state';
	import { useAccount, type Viewer } from './viewer-session.svelte';
	import { INVITATION_PATH, currentDestination, onboardingHref, localReturn } from './navigation';
	import WorkspaceScope from './WorkspaceScope.svelte';
	import WorkspaceShell from './WorkspaceShell.svelte';
	import WorkspaceRedirect from './WorkspaceRedirect.svelte';
	import Workspace from './Workspace.svelte';
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
	const account = useAccount();
	const member = $derived.by((): Viewer | undefined => {
		const value = account();
		return value?.membership && value.company
			? { ...value, membership: value.membership, company: value.company }
			: undefined;
	});
	const onboardingTarget = $derived.by(() => {
		const returning = page.url.pathname === '/team' ? page.url.searchParams.get('returnTo') : null;
		const destination = returning ? localReturn(returning) : currentDestination(page.url);
		return new URL(destination, page.url).pathname === INVITATION_PATH
			? destination
			: onboardingHref(destination);
	});
</script>

{#if member}
	{#key `${member.profile.id}:${member.membership.id}:${member.company.id}`}
		<WorkspaceScope viewer={member}>
			<WorkspaceShell>
				<Workspace>{@render children()}</Workspace>
			</WorkspaceShell>
		</WorkspaceScope>
	{/key}
{:else}
	<WorkspaceRedirect
		to={onboardingTarget}
		layout="screen"
		label="Opening your workspace"
		errorMessage="We couldn’t open company setup. Please try again."
	/>
{/if}
