<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import { useAccount, useViewerSession } from '../viewer-session.svelte';
	import { workspaceDestination } from '../navigation';
	import { recordStartup } from '../startup-perf';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
	import ChooseCompanyStep from './ChooseCompanyStep.svelte';
	import CreateCompanyStep from './CreateCompanyStep.svelte';
	import JoinCompanyStep from './JoinCompanyStep.svelte';

	type Step = 'choose' | 'create' | 'join';
	const account = useAccount();
	const client = useConvexClient();
	const session = useViewerSession();
	const destination = $derived(workspaceDestination(page.url.searchParams.get('returnTo')));
	let step = $state<Step>('choose');
	let name = $state('');
	let pending = $state(false);
	let error = $state('');
	let alive = true;
	let completionAttempted = false;
	onMount(() => recordStartup('usable'));
	onDestroy(() => (alive = false));

	function active(generation: number) {
		return alive && !session.blocked && generation === session.transportGeneration;
	}

	// This flow owns completion. Additional setup steps belong here before workspace navigation.
	async function complete() {
		const generation = session.transportGeneration;
		if (completionAttempted || !active(generation)) return;
		// A cancelled navigation must not restart when mutation or session state changes.
		completionAttempted = true;
		try {
			await goto(destination, { replaceState: true });
		} catch {
			if (active(generation)) error = 'We couldn’t open your workspace. Please reload.';
		}
	}

	$effect(() => {
		if (account()?.membership && !pending && !session.blocked) untrack(() => void complete());
	});

	function showStep(next: Step) {
		if (pending || session.blocked) return;
		error = '';
		step = next;
	}

	async function run(work: () => Promise<unknown>) {
		if (pending || session.blocked) return;
		const generation = session.transportGeneration;
		pending = true;
		error = '';
		try {
			await work();
		} catch (e) {
			if (active(generation))
				error = e instanceof Error ? e.message : 'Unable to join your company. Please try again.';
		} finally {
			if (alive) pending = false;
		}
	}
</script>

{#if step === 'create' && !account()?.membership}
	<div class="mx-auto h-5 w-full max-w-190">
		<button
			type="button"
			class="inline-flex cursor-pointer items-center gap-2 text-[13px] text-[#8f9297] transition-colors hover:text-ink focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-55"
			disabled={pending || session.blocked}
			onclick={() => showStep('choose')}
		>
			<ArrowLeftIcon size={14} aria-hidden="true" /> Back
		</button>
	</div>
{/if}

<div class="m-auto w-full max-w-190 pt-7 pb-15 text-center">
	{#if account()?.membership}
		<LoadingState label="Opening your workspace" />
		{#if error}<p role="alert" class="text-center text-sm text-danger">{error}</p>{/if}
	{:else if step === 'choose'}
		<ChooseCompanyStep
			disabled={pending || session.blocked}
			oncreate={() => showStep('create')}
			onjoin={() => showStep('join')}
		/>
	{:else if step === 'create'}
		<CreateCompanyStep
			bind:name
			{pending}
			{error}
			blocked={session.blocked}
			onsubmit={(name) => void run(() => client.mutation(api.companies.create, { name }))}
		/>
	{:else}
		<JoinCompanyStep
			{pending}
			{error}
			onjoin={(invitationId) =>
				void run(() => client.mutation(api.companyInvitations.accept, { invitationId }))}
			oncreate={() => showStep('create')}
		/>
	{/if}
</div>

<footer class="translate-y-2 text-center text-xs leading-5 text-[#8f9297]">
	<p class="break-words">Signed in as {account()?.profile.email}</p>
	<button
		type="button"
		class="mt-1 cursor-pointer underline underline-offset-2 hover:text-ink focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-55"
		disabled={pending || session.blocked}
		onclick={() => void session.signOut()}>Sign out</button
	>
</footer>
