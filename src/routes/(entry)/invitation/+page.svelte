<script lang="ts">
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import { useClerkContext } from 'svelte-clerk';
	import EmailCodeFlow from '$lib/auth/EmailCodeFlow.svelte';
	import RequireAccount from '$lib/auth/RequireAccount.svelte';
	import AccountLoading from '$lib/auth/AccountLoading.svelte';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import { useViewerSession } from '$lib/auth/viewer-session.svelte';
	import AuthStepFrame from '$lib/auth/components/AuthStepFrame.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	const clerk = useClerkContext();
	const session = useViewerSession();
	const signedIn = $derived(Boolean(clerk.auth.sessionId || clerk.session));
	let expired = $state(false);
	let retrying = $state(false);
	let previewReloadedFor: string | null | undefined;
	$effect(() => {
		expired = false;
		if (signedIn || data.preview?.status !== 'available') return;
		const timer = setTimeout(() => (expired = true), data.preview.expiresInMs);
		return () => clearTimeout(timer);
	});
	$effect(() => {
		if (!data.previewSkipped || !clerk.isLoaded || signedIn) return;
		untrack(() => {
			// Recover once if the browser session disappeared after server authentication.
			if (previewReloadedFor === data.token) return;
			previewReloadedFor = data.token;
			void retryPreview();
		});
	});
	async function retryPreview() {
		if (retrying) return;
		retrying = true;
		try {
			await invalidateAll();
		} catch {
			// Keep the invitation error and retry control available after a failed reload.
		} finally {
			retrying = false;
		}
	}
	const invitation = loadComponent(
		() => import('$lib/auth/InvitationLink.svelte'),
		() => Boolean(page.url.searchParams.get('invitation') && signedIn),
		() => session.transportGeneration
	);
	const InvitationLink = $derived(invitation.component);
</script>

<svelte:head>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

{#if !page.url.searchParams.get('invitation')}
	<AuthStepFrame
		title="Invitation unavailable"
		description="Open the invitation link from your email, or ask a colleague for a new invitation."
	>
		<a href="/login" class="block text-center text-sm underline">Log in to Agreed</a>
	</AuthStepFrame>
{:else if signedIn}
	<RequireAccount inline>
		{#if InvitationLink}<InvitationLink />
		{:else}
			<AuthStepFrame title="Company invitation">
				<LoadingState label={invitation.failed ? undefined : 'Loading invitation'}>
					{#if invitation.failed}
						<p role="alert" class="text-center text-sm text-danger">
							Unable to load this invitation. Please try again.
						</p>
						<button class="text-sm underline" onclick={() => invitation.retry()}>Try again</button>
					{/if}
				</LoadingState>
			</AuthStepFrame>
		{/if}
	</RequireAccount>
{:else if data.previewSkipped && !clerk.isLoaded}
	<AccountLoading inline />
{:else if data.token !== page.url.searchParams.get('invitation') || (data.previewSkipped && retrying)}
	<LoadingState label="Loading invitation" />
{:else if data.preview?.status === 'available' && !expired}
	{#key data.token}<EmailCodeFlow invitation={data.preview} />{/key}
{:else if !data.preview}
	<AuthStepFrame title="Company invitation">
		<div class="grid justify-items-center gap-4">
			<p role="alert" class="text-center text-sm text-danger">{data.error}</p>
			<button class="text-sm underline" disabled={retrying} onclick={() => void retryPreview()}>
				{retrying ? 'Loading…' : 'Try again'}
			</button>
		</div>
	</AuthStepFrame>
{:else}
	<AuthStepFrame
		title={data.preview.status === 'accepted'
			? 'Invitation already accepted'
			: data.preview.status === 'expired' || data.preview.status === 'available'
				? 'Invitation expired'
				: data.preview.status === 'revoked'
					? 'Invitation revoked'
					: 'Invitation unavailable'}
		description={data.preview.status === 'accepted'
			? 'This invitation has already been used. Log in to open your workspace, or ask a colleague for a new invitation.'
			: 'Open the latest invitation email, or ask a colleague for a new invitation.'}
	>
		<a href="/login" class="block text-center text-sm underline">Log in to Agreed</a>
	</AuthStepFrame>
{/if}
