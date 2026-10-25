<script lang="ts">
	import { useViewerSession } from './viewer-session.svelte';
	import { useClerkReadiness } from './clerk-readiness';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import { page } from '$app/state';
	import WorkspaceSkeleton from './WorkspaceSkeleton.svelte';
	let { inline = false }: { inline?: boolean } = $props();
	const session = useViewerSession();
	const readiness = useClerkReadiness();
	const failure = $derived(
		readiness.error || (session.phase === 'authentication-error' ? session.authenticationError : '')
	);
	async function retry() {
		try {
			await readiness.retry();
			session.retryAuth();
		} catch {
			/* The provider exposes the connection error. */
		}
	}
</script>

{#snippet recovery()}
	{#if failure || session.delayed}
		<p role={failure ? 'alert' : 'status'} class="max-w-md text-sm text-ink-muted">
			{failure || 'This is taking longer than usual.'}
		</p>
		<div class="flex gap-5 text-sm">
			<button class="underline" onclick={() => void retry()}>Try again</button>
			<button class="underline" onclick={() => void session.signOut()}>Log out</button>
		</div>
	{/if}
{/snippet}

{#if !inline && page.route.id?.startsWith('/(workspace)') && !failure}
	{#if session.delayed}
		<WorkspaceSkeleton header announce={false}>{@render recovery()}</WorkspaceSkeleton>
	{:else}
		<WorkspaceSkeleton header label="Connecting your account" />
	{/if}
{:else}
	<LoadingState
		layout={inline ? 'section' : 'screen'}
		label={failure ? undefined : 'Connecting your account'}
	>
		{@render recovery()}
	</LoadingState>
{/if}
