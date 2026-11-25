<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import { useAccount, useViewerSession } from '../viewer-session.svelte';
	import { workspaceDestination } from '../navigation';
	import { afterStartupPaint, recordStartup } from '../startup-perf';
	import { preloadDestination } from '../destination-code';
	import {
		csmPreviewScope,
		useCsmOnboardingPreview
	} from '$lib/components/chrome/csm-onboarding-preview.svelte';
	import { browserTimeZone } from '$lib/components/chrome/csm-time';
	import { walkthroughVideos } from '$lib/videos';
	import { warmVideoPoster } from '$lib/ui/video.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
	import ChooseCompanyStep from './ChooseCompanyStep.svelte';
	import CreateCompanyStep from './CreateCompanyStep.svelte';
	import JoinCompanyStep from './JoinCompanyStep.svelte';
	import RouteTitle from '../RouteTitle.svelte';
	import OnboardingLayout from './OnboardingLayout.svelte';

	type Step = 'choose' | 'create' | 'join';
	const account = useAccount();
	const client = useConvexClient();
	const session = useViewerSession();
	const csmPreview = useCsmOnboardingPreview();
	const destination = $derived(workspaceDestination(page.url.searchParams.get('returnTo')));
	let step = $state<Step>('choose');
	let name = $state('');
	let pending = $state(false);
	let error = $state('');
	let completionDestination: string | undefined;
	let alive = true;
	let completionAttempted = false;
	const title = $derived(
		account()?.membership
			? 'Opening your workspace'
			: step === 'choose'
				? 'Choose how to get started'
				: step === 'create'
					? 'Name your company'
					: 'Join your team'
	);
	const canPreload = $derived(
		step !== 'join' && !session.blocked && !session.error && !pending && !account()?.membership
	);
	onMount(() => recordStartup('usable'));
	onDestroy(() => (alive = false));

	function current(generation: number) {
		return alive && generation === session.transportGeneration;
	}

	// This flow owns completion. Additional setup steps belong here before workspace navigation.
	async function complete() {
		const generation = session.transportGeneration;
		if (completionAttempted || !account()?.membership || session.blocked || !current(generation))
			return;
		// A cancelled navigation must not restart when mutation or session state changes.
		completionAttempted = true;
		try {
			await goto(completionDestination ?? destination, {
				replaceState: true
			});
		} catch {
			if (current(generation)) error = 'We couldn’t open your workspace. Please reload.';
		}
	}

	$effect(() => {
		if (account()?.membership && !pending && !session.blocked) untrack(() => void complete());
	});

	$effect(() => {
		if (!canPreload) return;
		const generation = session.transportGeneration;
		// Warm template setup after onboarding paints; other destinations load when requested.
		return afterStartupPaint(() => {
			if (canPreload && current(generation))
				void preloadDestination('/template/setup').catch(() => {});
		});
	});
	$effect(() => {
		if (step !== 'create' || pending || session.blocked || session.closing || account()?.membership)
			return;
		warmVideoPoster(walkthroughVideos.templateSetup.poster, 'low');
		const scope = csmPreviewScope(
			session.userId,
			session.preparedSessionId,
			session.transportGeneration
		);
		if (!scope) return;
		const timeZone = browserTimeZone();
		csmPreview?.start(scope, timeZone, () =>
			client.action(api.csmBookings.onboardingAvailability, { timeZone })
		);
	});

	function showStep(next: Step) {
		if (pending || session.blocked) return;
		error = '';
		step = next;
	}

	async function run(work: () => Promise<unknown>, nextDestination = destination) {
		if (pending || session.blocked) return;
		const generation = session.transportGeneration;
		pending = true;
		error = '';
		try {
			await work();
			if (current(generation)) {
				completionDestination = nextDestination;
			}
		} catch (e) {
			if (current(generation))
				error =
					e instanceof Error ? e.message : 'Unable to finish company setup. Please try again.';
		} finally {
			if (alive) pending = false;
		}
	}
</script>

<RouteTitle {title} />

{#if step === 'create' && !account()?.membership}
	<div class="absolute inset-x-6 top-8 mx-auto h-5 max-w-190 sm:top-12">
		<button
			type="button"
			class="inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-muted transition-colors hover:text-ink focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:text-ink-muted"
			disabled={pending || session.blocked}
			onclick={() => showStep('choose')}
		>
			<ArrowLeftIcon class="size-3.5" aria-hidden="true" /> Back
		</button>
	</div>
{/if}

<OnboardingLayout showProgress={!account()?.membership}>
	{#snippet children()}
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
				onsubmit={(name) =>
					void run(() => client.mutation(api.companies.create, { name }), '/template/setup')}
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
	{/snippet}
	{#snippet footer()}
		<button
			type="button"
			class="mt-1 cursor-pointer underline underline-offset-2 hover:text-ink focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:text-ink-muted"
			disabled={pending || session.blocked}
			onclick={() => void session.signOut()}>Log out</button
		>
	{/snippet}
</OnboardingLayout>
