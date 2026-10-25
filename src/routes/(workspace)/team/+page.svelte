<script lang="ts">
	import { page } from '$app/state';
	import { localReturn } from '$lib/auth/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { useConvexClient, usePaginatedQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import TeamRowsSkeleton from '$lib/components/workspace/TeamRowsSkeleton.svelte';
	import InviteColleaguesModal from '$lib/features/settings/InviteColleaguesModal.svelte';
	import { Button } from '$lib/ui';
	const client = useConvexClient();
	const session = useViewerSession();
	const viewer = useViewer();
	const returnTo = $derived(page.url.searchParams.get('returnTo'));
	const invitationReturn = $derived(
		returnTo && new URL(localReturn(returnTo), page.url).pathname === '/invitation'
			? localReturn(returnTo)
			: null
	);
	const membershipId = viewer().membership.id;
	const canManage = $derived(viewer().permissions.manageMembers);
	const isOwner = $derived(viewer().membership.isOwner);
	let now = $state(Math.floor(Date.now() / 60_000) * 60_000);
	onMount(() => {
		const timer = setInterval(() => (now = Math.floor(Date.now() / 60_000) * 60_000), 60_000);
		return () => clearInterval(timer);
	});
	const colleagues = usePaginatedQuery(
		api.profiles.colleagues,
		{ membershipId },
		{ initialNumItems: 50 }
	);
	const invitations = usePaginatedQuery(
		api.companyInvitations.list,
		() => (canManage ? { membershipId } : 'skip'),
		{ initialNumItems: 50 }
	);
	const colleaguesLoading = $derived(
		colleagues.status === 'LoadingFirstPage' && !colleagues.results.length && !colleagues.error
	);
	const invitationsLoading = $derived(
		canManage &&
			invitations.status === 'LoadingFirstPage' &&
			!invitations.results.length &&
			!invitations.error
	);
	let modalOpen = $state(false);
	let emailInput = $state('');
	let sending = $state(false);
	let busy = $state(false);
	let error = $state('');
	let modalError = $state<string | null>(null);
	let leaving = $state(false);
	let leaveFailed = $state(false);
	let confirmAction = $state<{ message: string; run: () => Promise<unknown> }>();
	let alive = true;
	onDestroy(() => (alive = false));
	async function run(action: () => Promise<unknown>) {
		if (busy || session.blocked) return;
		busy = true;
		error = '';
		try {
			await action();
			if (alive) confirmAction = undefined;
		} catch (e) {
			if (alive) error = e instanceof Error ? e.message : 'Unable to update your company.';
		} finally {
			if (alive) busy = false;
		}
	}
	async function leave(discard = false) {
		if (busy) return;
		busy = true;
		error = '';
		try {
			await session.exitCompany(
				() => client.mutation(api.companies.leave, { membershipId }),
				discard
			);
		} catch (e) {
			if (alive) {
				leaveFailed = true;
				error = e instanceof Error ? e.message : 'Unable to leave your company.';
			}
		} finally {
			if (alive) busy = false;
		}
	}
	async function invite() {
		if (sending || session.blocked || !canManage) return;
		const emails = [
			...new Set(
				emailInput
					.split(/[;,\n]/)
					.map((email) => email.trim().toLowerCase())
					.filter(Boolean)
			)
		];
		if (
			!emails.length ||
			emails.length > 50 ||
			emails.some((email) => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
		) {
			modalError = 'Enter up to 50 valid email addresses separated by commas.';
			return;
		}
		sending = true;
		modalError = null;
		const generation = session.transportGeneration;
		emailInput = emails.join(', ');
		try {
			const result = await client.action(api.invitationEmail.invite, { membershipId, emails });
			if (!alive) return;
			if (session.blocked || !canManage || generation !== session.transportGeneration)
				throw new Error('Your connection changed. Please try again.');
			const failed = result.filter((delivery) => delivery.error !== null);
			emailInput = failed.map((delivery) => delivery.email).join(', ');
			if (failed.length) modalError = failed[0].error;
			else modalOpen = false;
		} catch (e) {
			if (alive) modalError = e instanceof Error ? e.message : 'Unable to send invitations.';
		} finally {
			if (alive) sending = false;
		}
	}
</script>

<main class="min-h-[calc(100dvh-var(--app-header-height))] bg-surface px-6 py-8">
	{#if colleaguesLoading || invitationsLoading}
		<span role="status" class="sr-only"
			>{colleaguesLoading && invitationsLoading
				? 'Loading colleagues and invitations'
				: colleaguesLoading
					? 'Loading colleagues'
					: 'Loading invitations'}</span
		>
	{/if}
	<div class="mx-auto max-w-4xl space-y-8">
		{#if invitationReturn}<a href={invitationReturn} class="text-sm underline"
				>Return to invitation</a
			>{/if}
		<div class="flex items-center justify-between gap-4">
			<div>
				<h1 class="text-sm font-medium">{viewer().company.name}</h1>
				<p class="mt-2 text-sm text-ink-muted">
					Your company is private. Colleagues join by invitation.
				</p>
			</div>
			{#if canManage}<Button
					disabled={busy || session.blocked}
					onclick={() => {
						modalError = null;
						modalOpen = true;
					}}>Invite colleagues</Button
				>{/if}
		</div>
		<section aria-labelledby="colleagues-heading">
			<h2 id="colleagues-heading" class="mb-3 text-sm font-medium">Colleagues</h2>
			{#if colleaguesLoading}
				<TeamRowsSkeleton />
			{:else}
				<ul class="divide-y divide-stone-200 rounded-xl border border-stone-200">
					{#each colleagues.results as person (person.membershipId)}
						<li class="flex flex-wrap items-center gap-3 p-4">
							<Avatar
								name={person.name || person.email}
								avatarUrl={person.avatarUrl}
								size={28}
								decorative
							/>
							<div class="min-w-0 flex-1">
								<p class="text-sm">
									{person.name || person.email}{person.membershipId === membershipId
										? ' (you)'
										: ''}
								</p>
								<p class="text-xs text-ink-muted">{person.email}</p>
							</div>
							<span class="text-xs text-ink-muted"
								>{person.role === 'admin' ? 'Admin' : 'Rep'}{person.isOwner ? ' · Owner' : ''}</span
							>
							{#if isOwner && !person.isOwner}
								<Button
									variant="ghost"
									disabled={busy || session.blocked}
									onclick={() =>
										(confirmAction = {
											message: `Transfer company ownership to ${person.name || person.email}? They will manage company ownership.`,
											run: () =>
												client.mutation(api.companies.transferOwnership, {
													membershipId,
													targetMembershipId: person.membershipId
												})
										})}>Transfer ownership</Button
								>
							{/if}
							{#if canManage && !person.isOwner && person.membershipId !== membershipId}
								<Button
									variant="ghost"
									disabled={busy || session.blocked}
									onclick={() =>
										(confirmAction = {
											message: `Remove ${person.name || person.email} from your company? Their contracts will stay with the company.`,
											run: () =>
												client.mutation(api.companies.removeMember, {
													membershipId,
													targetMembershipId: person.membershipId
												})
										})}>Remove</Button
								>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
			{#if colleagues.error}<p role="alert" class="mt-3 text-sm text-danger">
					Unable to load colleagues. Reload to try again.
				</p>{/if}
			{#if colleagues.status === 'CanLoadMore'}<Button
					variant="ghost"
					onclick={() => colleagues.loadMore(50)}>Load more colleagues</Button
				>{/if}
		</section>
		{#if canManage}
			<section aria-labelledby="invitations-heading">
				<h2 id="invitations-heading" class="mb-3 text-sm font-medium">Pending invitations</h2>
				{#if invitationsLoading}
					<TeamRowsSkeleton invitations />
				{:else}
					<ul class="divide-y divide-stone-200 rounded-xl border border-stone-200">
						{#each invitations.results as invitation (invitation.id)}
							<li class="flex flex-wrap items-center gap-3 p-4">
								<div class="flex-1">
									<p class="text-sm">{invitation.email}</p>
									<p class="text-xs text-ink-muted">
										{invitation.expiresAt <= now
											? 'Expired'
											: invitation.deliveryStatus === 'failed'
												? 'Delivery unconfirmed'
												: invitation.deliveryStatus === 'sending'
													? 'Sending…'
													: 'Waiting to join'}
									</p>
								</div>
								<Button
									variant="secondary"
									disabled={busy || session.blocked}
									onclick={() =>
										run(async () => {
											const [delivery] = await client.action(api.invitationEmail.invite, {
												membershipId,
												emails: [invitation.email],
												resend: true
											});
											if (delivery.error) throw new Error(delivery.error);
										})}>Resend</Button
								>
								<Button
									variant="ghost"
									disabled={busy || session.blocked}
									onclick={() =>
										run(() =>
											client.mutation(api.companyInvitations.revoke, {
												membershipId,
												invitationId: invitation.id
											})
										)}>Revoke</Button
								>
							</li>
						{:else}{#if !invitations.error && invitations.status === 'Exhausted'}<li
									class="p-4 text-sm text-ink-muted"
								>
									No pending invitations.
								</li>{/if}{/each}
					</ul>
				{/if}
				{#if invitations.error}<p role="alert" class="mt-3 text-sm text-danger">
						Unable to load invitations. Reload to try again.
					</p>{/if}
				{#if invitations.status === 'CanLoadMore'}<Button
						variant="ghost"
						onclick={() => invitations.loadMore(50)}>Load more invitations</Button
					>{/if}
			</section>
		{/if}
		{#if confirmAction}
			<div class="rounded-xl border border-stone-200 p-4">
				<p class="mb-3 text-sm">{confirmAction.message}</p>
				<div class="flex gap-2">
					<Button disabled={busy} onclick={() => confirmAction && run(confirmAction.run)}
						>Confirm</Button
					><Button variant="ghost" disabled={busy} onclick={() => (confirmAction = undefined)}
						>Cancel</Button
					>
				</div>
			</div>
		{/if}
		<section class="border-t border-stone-200 pt-6">
			<h2 class="text-sm font-medium">Leave company</h2>
			{#if isOwner}<p class="mt-2 text-sm text-ink-muted">
					Transfer ownership to a colleague before leaving or deleting your account.
				</p>
			{:else}
				<p class="mt-2 text-sm text-ink-muted">
					Your contracts stay with {viewer().company.name}. You’ll need a new invitation to return.
				</p>
				{#if leaving}
					<p class="mt-4 text-sm">
						Leave {viewer().company.name}? We’ll save your pending changes first.
					</p>
					<div class="mt-3 flex flex-wrap gap-2">
						<Button disabled={busy || session.blocked} onclick={() => leave()}
							>{busy ? 'Saving and leaving…' : 'Save and leave'}</Button
						>{#if leaveFailed}<Button
								variant="secondary"
								disabled={busy}
								onclick={() => leave(true)}>Discard changes and leave</Button
							>{/if}<Button
							variant="ghost"
							disabled={busy}
							onclick={() => {
								leaving = false;
								leaveFailed = false;
								error = '';
							}}>Cancel</Button
						>
					</div>
				{:else}<Button
						variant="ghost"
						disabled={busy || session.blocked}
						onclick={() => (leaving = true)}>Leave company</Button
					>{/if}
			{/if}
		</section>
		{#if error}<p role="alert" class="text-sm text-danger">{error}</p>{/if}
	</div>
</main>
<InviteColleaguesModal
	open={modalOpen && canManage}
	value={emailInput}
	error={modalError}
	isAdding={sending}
	onClose={() => {
		if (!sending) modalOpen = false;
	}}
	onSubmit={invite}
	onValueChange={(value) => {
		if (!sending) emailInput = value;
	}}
/>
