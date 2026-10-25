<script lang="ts">
	import { untrack } from 'svelte';
	import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
	import { useQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { useAccount, useViewerSession } from '../viewer-session.svelte';
	import OnboardingStepFrame from './OnboardingStepFrame.svelte';
	import AuthButton from '../components/AuthButton.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';

	let {
		pending,
		error,
		onjoin,
		oncreate
	}: {
		pending: boolean;
		error: string;
		onjoin: (invitationId: Id<'companyInvitations'>) => void;
		oncreate: () => void;
	} = $props();
	const account = useAccount();
	const session = useViewerSession();
	const invitations = useQuery(api.companyInvitations.inbox, () =>
		account()?.membership ? 'skip' : {}
	);
	let timedOut = $state(false);
	$effect(() => {
		void session.transportGeneration;
		const loading = invitations.isLoading;
		untrack(() => (timedOut = false));
		if (account()?.membership || !loading) return;
		const timer = setTimeout(() => (timedOut = true), 15_000);
		return () => clearTimeout(timer);
	});
</script>

<OnboardingStepFrame
	title="Join your team"
	description="Accept an invitation to work with your colleagues on Agreed."
>
	<div class="mx-auto grid max-w-92 gap-3.5 text-left">
		{#if invitations.error || timedOut}
			<p role="alert" class="text-center text-sm text-danger">Unable to load invitations.</p>
			<button class="text-sm underline" onclick={() => session.retryAuth()}>Try again</button>
		{:else if invitations.data?.length}
			{#each invitations.data as invitation (invitation.id)}
				<div class="rounded-xl border border-stone-200/60 bg-white p-5">
					<p class="text-sm font-medium break-words">{invitation.companyName}</p>
					<p class="mt-1 mb-5 text-xs leading-5 break-words text-stone-500">
						Invited by {invitation.inviterName}
					</p>
					<AuthButton disabled={pending || session.blocked} onclick={() => onjoin(invitation.id)}
						>{pending ? 'Joining…' : 'Join company'}</AuthButton
					>
				</div>
			{/each}
		{:else if invitations.data}
			<div class="rounded-xl border border-stone-200/60 bg-white p-6 text-center">
				<UsersIcon size={24} weight="light" aria-hidden="true" class="mx-auto text-stone-400" />
				<h2 class="mt-4 text-sm font-medium">Ask a colleague for an invitation</h2>
				<p class="mt-2 text-[13px] leading-5 text-[#686b73]">
					They’ll need to invite <span class="break-words text-ink">{account()?.profile.email}</span
					>. Your invitation will appear here automatically.
				</p>
			</div>
		{:else}
			<LoadingState label="Loading invitations" />
		{/if}
		{#if error}<p role="alert" class="text-center text-sm leading-5 text-danger">{error}</p>{/if}
	</div>
	<button
		type="button"
		class="mt-7 cursor-pointer text-[13px] text-[#8f9297] underline underline-offset-2 hover:text-ink focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-55"
		disabled={pending || session.blocked}
		onclick={oncreate}>Create a company instead</button
	>
</OnboardingStepFrame>
