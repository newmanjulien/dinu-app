<script lang="ts">
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import InvitationSkeleton from '$lib/auth/InvitationSkeleton.svelte';
	import type { InvitationPreview } from '../../../convex/invitationValidators';
	import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
	import { untrack } from 'svelte';
	import { useClerkContext } from 'svelte-clerk';
	import EmailCodeFlow from '$lib/auth/EmailCodeFlow.svelte';
	import RequireAccount from '$lib/auth/RequireAccount.svelte';
	import AccountLoading from '$lib/auth/AccountLoading.svelte';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import { useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { LOGIN_PATH } from '$lib/auth/navigation';
	import AuthStepFrame from '$lib/auth/components/AuthStepFrame.svelte';

	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	let streamed = $state<{ preview: InvitationPreview | null; error: string }>();
	$effect(() => {
		const request = data.previewRequest;
		let active = true;
		streamed = undefined;
		if (!request) return;
		const read = new ReadAttempt(15_000);
		void waitForRead(Promise.resolve(request), read.signal)
			.then((value) => {
				if (active) streamed = value;
			})
			.catch(() => {
				if (active)
					streamed = { preview: null, error: 'Unable to load this invitation. Please try again.' };
			})
			.finally(() => read.complete());
		return () => {
			active = false;
			read.abort();
		};
	});
	const preview = $derived(data.preview ?? streamed?.preview);
	const previewPending = $derived(Boolean(data.previewRequest && !streamed));
	const clerk = useClerkContext();
	const session = useViewerSession();
	const signedIn = $derived(Boolean(clerk.auth.sessionId || clerk.session));
	let expired = $state(false);
	let retrying = $state(false);
	let previewReloadedFor: string | null | undefined;
	$effect(() => {
		expired = false;
		if (signedIn || preview?.status !== 'available') return;
		const timer = setTimeout(() => (expired = true), preview.expiresInMs);
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
		<a href={LOGIN_PATH} class="block text-center text-sm underline">Log in to Dinu</a>
	</AuthStepFrame>
{:else if signedIn}
	<RequireAccount inline>
		{#snippet loading({ announce })}<InvitationSkeleton entry="signed-in" {announce} />{/snippet}
		{#if InvitationLink}<InvitationLink />
		{:else if invitation.failed}
			<AuthStepFrame title="Company invitation">
				<div class="grid gap-4">
					<p role="alert" class="text-center text-sm text-danger">
						Unable to load this invitation. Please try again.
					</p>
					<button class="text-sm underline" onclick={() => invitation.retry()}>Try again</button>
				</div>
			</AuthStepFrame>
		{:else}
			<InvitationSkeleton entry="signed-in" />
		{/if}
	</RequireAccount>
{:else if data.previewSkipped && !clerk.isLoaded}
	<AccountLoading inline>
		{#snippet loading({ announce })}<InvitationSkeleton {announce} />{/snippet}
	</AccountLoading>
{:else if data.token !== page.url.searchParams.get('invitation') || (data.previewSkipped && retrying)}
	<InvitationSkeleton />
{:else if previewPending}
	<InvitationSkeleton
		entry={clerk.isLoaded && preview?.status === 'available' && !expired ? 'signed-out' : 'unknown'}
	/>
{:else if preview?.status === 'available' && !expired}
	{#key data.token}<EmailCodeFlow mode="invitation" invitation={preview} />{/key}
{:else if !preview}
	<AuthStepFrame title="Company invitation">
		<div class="grid justify-items-center gap-4">
			<p role="alert" class="text-center text-sm text-danger">{streamed?.error || data.error}</p>
			<button class="text-sm underline" disabled={retrying} onclick={() => void retryPreview()}>
				{retrying ? 'Loading…' : 'Try again'}
			</button>
		</div>
	</AuthStepFrame>
{:else}
	<AuthStepFrame
		title={preview.status === 'accepted'
			? 'Invitation already accepted'
			: preview.status === 'expired' || preview.status === 'available'
				? 'Invitation expired'
				: preview.status === 'revoked'
					? 'Invitation revoked'
					: 'Invitation unavailable'}
		description={preview.status === 'accepted'
			? 'This invitation has already been used. Log in to open your workspace, or ask a colleague for a new invitation.'
			: 'Open the latest invitation email, or ask a colleague for a new invitation.'}
	>
		<a href={LOGIN_PATH} class="block text-center text-sm underline">Log in to Dinu</a>
	</AuthStepFrame>
{/if}
