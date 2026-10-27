<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { untrack, onDestroy } from 'svelte';
	import { ReadAttempt, waitForRead } from './attempt';
	import { useAccount, useViewerSession } from './viewer-session.svelte';
	import { currentDestination } from './navigation';
	import { recordStartup } from './startup-perf';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../convex/_generated/api';
	import type { InvitationResolution } from '../../convex/invitationValidators';
	import AuthButton from './components/AuthButton.svelte';
	import AuthStepFrame from './components/AuthStepFrame.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	const client = useConvexClient();
	const session = useViewerSession();
	const account = useAccount();
	let epoch = 0;
	let alive = true;
	onDestroy(() => {
		alive = false;
		epoch++;
	});
	let resolvedToken: string | null | undefined;
	let writeEpoch = 0;
	let result = $state<InvitationResolution>();
	let pending = $state(false);
	let joined = $state(false);
	let error = $state('');
	let retry = $state(0);
	const teamHref = $derived(
		`/team?returnTo=${encodeURIComponent(currentDestination(page.url))}` as const
	);
	$effect(() => {
		const token = page.url.searchParams.get('invitation');
		const generation = session.transportGeneration;
		const membership = account()?.membership?.id;
		void retry;
		return untrack(() => {
			if (resolvedToken !== token) {
				resolvedToken = token;
				writeEpoch++;
				joined = false;
				pending = false;
			}
			if (joined) return;
			const current = ++epoch;
			result = undefined;
			error = '';
			if (!token) {
				error = 'This invitation link is incomplete.';
				return;
			}
			const read = new ReadAttempt(15_000);
			void waitForRead(client.action(api.invitationLinks.resolve, { token }), read.signal)
				.then((value) => {
					if (
						alive &&
						current === epoch &&
						generation === session.transportGeneration &&
						membership === account()?.membership?.id
					) {
						result = value;
						recordStartup('usable');
					}
				})
				.catch(() => {
					if (current === epoch && generation === session.transportGeneration)
						error = 'Unable to load this invitation. Please try again.';
				})
				.finally(() => read.complete());
			return () => {
				epoch++;
				read.abort();
			};
		});
	});
	async function accept() {
		if (result?.status !== 'available' || pending || session.blocked) return;
		const invitation = result;
		const generation = session.transportGeneration;
		const userId = session.userId;
		const token = page.url.searchParams.get('invitation');
		const write = ++writeEpoch;
		const current = () =>
			alive &&
			write === writeEpoch &&
			token === page.url.searchParams.get('invitation') &&
			userId === session.userId &&
			generation === session.transportGeneration;
		pending = true;
		error = '';
		try {
			await client.mutation(api.companyInvitations.accept, {
				invitationId: invitation.invitationId,
				deliveryGeneration: invitation.deliveryGeneration
			});
			if (!current()) return;
			joined = true;
			await goto('/', { replaceState: true });
		} catch (e) {
			if (current()) error = e instanceof Error ? e.message : 'Unable to accept this invitation.';
		} finally {
			if (alive && write === writeEpoch) pending = false;
		}
	}
</script>

{#if joined || result?.status === 'already-member'}
	<AuthStepFrame
		title={joined ? 'You’re in' : 'You’re already on this team'}
		description={result?.companyName
			? `Open ${result.companyName} on Dinu.`
			: 'Your company is ready to open.'}
	>
		<AuthButton href="/">Open workspace</AuthButton>
		{#if error}<p role="alert" class="mt-3 text-sm text-danger">{error}</p>{/if}
	</AuthStepFrame>
{:else if result?.status === 'available'}
	<AuthStepFrame
		title={`Join ${result.companyName}`}
		description={`You’re invited to join ${result.companyName}.`}
	>
		<div class="grid gap-3.5">
			<AuthButton disabled={pending || session.blocked} onclick={() => void accept()}
				>{pending ? 'Joining…' : `Join ${result.companyName}`}</AuthButton
			>
			{#if error}<p role="alert" class="text-sm text-danger">{error}</p>{/if}
		</div>
	</AuthStepFrame>
{:else if result?.status === 'wrong-email'}
	<AuthStepFrame
		title="Use your invited email"
		description="This invitation was sent to a different email address. Switch accounts to continue."
	>
		<AuthButton disabled={session.blocked} onclick={() => void session.signOut()}
			>Switch account</AuthButton
		>
	</AuthStepFrame>
{:else if result?.status === 'other-company'}
	<AuthStepFrame
		title="You already belong to a company"
		description={`To join ${result.companyName}, first leave ${account()?.company?.name || 'your current company'} from the team page.`}
	>
		<AuthButton href={teamHref}>Manage current company</AuthButton>
		<p class="mt-3 text-center text-xs leading-5 text-ink-muted">
			You can return to this invitation after managing your membership.
		</p>
	</AuthStepFrame>
{:else if result}
	<AuthStepFrame
		title={result.status === 'accepted'
			? 'Invitation already accepted'
			: result.status === 'expired'
				? 'Invitation expired'
				: result.status === 'revoked'
					? 'Invitation revoked'
					: 'Invitation unavailable'}
		description={result.status === 'accepted'
			? 'If you left the company, ask a colleague for a new invitation.'
			: 'Ask a colleague for a new invitation to continue.'}
	>
		<a
			href={account()?.membership ? '/' : '/onboarding'}
			class="block text-center text-sm underline"
			>{account()?.membership ? 'Open your workspace' : 'Set up your company'}</a
		>
	</AuthStepFrame>
{:else}
	<AuthStepFrame title="Company invitation">
		<LoadingState label={error ? undefined : 'Loading invitation'}>
			{#if error}<p role="alert" class="text-center text-sm text-danger">{error}</p>
				<button class="text-sm underline" onclick={() => retry++}>Try again</button>
			{/if}
		</LoadingState>
	</AuthStepFrame>
{/if}
