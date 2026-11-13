<script lang="ts">
	import TeamLayout from '$lib/components/workspace/TeamLayout.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { page } from '$app/state';
	import { localReturn } from '$lib/auth/navigation';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { useConvexClient, usePaginatedQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import TeamListLayout from '$lib/components/workspace/TeamListLayout.svelte';
	import TeamRowLayout from '$lib/components/workspace/TeamRowLayout.svelte';
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
	let colleaguesRetry = $state(0),
		invitationsRetry = $state(0);
	let colleaguesTimedOut = $state(false),
		invitationsTimedOut = $state(false);
	const colleagues = usePaginatedQuery(
		api.profiles.colleagues,
		() => {
			void colleaguesRetry;
			return { membershipId };
		},
		{ initialNumItems: 50 }
	);
	const invitations = usePaginatedQuery(
		api.companyInvitations.list,
		() => {
			void invitationsRetry;
			return canManage ? { membershipId } : 'skip';
		},
		{ initialNumItems: 50 }
	);
	$effect(() => {
		void colleaguesRetry;
		void session.transportGeneration;
		const pending = colleagues.status === 'LoadingFirstPage' || colleagues.status === 'LoadingMore';
		untrack(() => (colleaguesTimedOut = false));
		if (!pending) return;
		const timer = setTimeout(() => (colleaguesTimedOut = true), 15_000);
		return () => clearTimeout(timer);
	});
	$effect(() => {
		void invitationsRetry;
		void session.transportGeneration;
		const pending =
			canManage &&
			(invitations.status === 'LoadingFirstPage' || invitations.status === 'LoadingMore');
		untrack(() => (invitationsTimedOut = false));
		if (!pending) return;
		const timer = setTimeout(() => (invitationsTimedOut = true), 15_000);
		return () => clearTimeout(timer);
	});
	const colleaguesLoading = $derived(
		colleagues.status === 'LoadingFirstPage' &&
			!colleagues.results.length &&
			!colleagues.error &&
			!colleaguesTimedOut
	);
	const invitationsLoading = $derived(
		canManage &&
			invitations.status === 'LoadingFirstPage' &&
			!invitations.results.length &&
			!invitations.error &&
			!invitationsTimedOut
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

<WorkspacePresentationReporter
	outcome={colleaguesLoading || invitationsLoading
		? 'pending'
		: colleagues.error || (canManage && invitations.error)
			? 'error'
			: 'success'}
/>

<TeamLayout role={viewer().membership.role} companyName={viewer().company.name} {canManage}>
	{#snippet status()}
		{#if colleaguesLoading || invitationsLoading}
			<span role="status" class="sr-only"
				>{colleaguesLoading && invitationsLoading
					? 'Loading colleagues and invitations'
					: colleaguesLoading
						? 'Loading colleagues'
						: 'Loading invitations'}</span
			>
		{/if}
	{/snippet}
	{#snippet notice()}
		{#if invitationReturn}<a href={invitationReturn} class="text-sm underline"
				>Return to invitation</a
			>{/if}
	{/snippet}
	{#snippet invite()}
		{#if canManage}<Button
				disabled={busy || session.blocked}
				onclick={() => {
					modalError = null;
					modalOpen = true;
				}}><PlusIcon class="size-[15px]" aria-hidden="true" />Invite</Button
			>{/if}
	{/snippet}
	{#snippet colleaguesContent()}
		{#if colleaguesLoading}
			<TeamRowsSkeleton {canManage} />
		{:else}
			<TeamListLayout>
				{#each colleagues.error ? [] : colleagues.results as person (person.membershipId)}
					<TeamRowLayout>
						{#snippet avatar()}<Avatar
								name={person.name || person.email}
								avatarUrl={person.avatarUrl}
								class="size-7"
								decorative
							/>{/snippet}
						{#snippet identity()}
							<p class="text-sm">
								{person.name || person.email}{person.membershipId === membershipId ? ' (you)' : ''}
							</p>
							<p class="text-xs text-ink-muted">{person.email}</p>
						{/snippet}
						{#snippet actions()}
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
						{/snippet}
					</TeamRowLayout>
				{/each}
			</TeamListLayout>
		{/if}
		{#if colleagues.error || colleaguesTimedOut}<p role="alert" class="mt-3 text-sm text-danger">
				Unable to load colleagues. <button class="underline" onclick={() => colleaguesRetry++}
					>Try again</button
				>
			</p>{/if}
		{#if colleagues.status === 'CanLoadMore'}<Button
				variant="ghost"
				onclick={() => colleagues.loadMore(50)}>Load more colleagues</Button
			>{/if}
	{/snippet}
	{#snippet invitationsContent()}
		{#if invitationsLoading}
			<TeamRowsSkeleton invitations />
		{:else}
			<TeamListLayout>
				{#each invitations.error ? [] : invitations.results as invitation (invitation.id)}
					<TeamRowLayout invitations>
						{#snippet identity()}
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
						{/snippet}
						{#snippet actions()}
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
						{/snippet}
					</TeamRowLayout>
				{:else}{#if !invitations.error && invitations.status === 'Exhausted'}<li
							class="p-3.5 text-[13px] text-ink-muted"
						>
							No pending invitations.
						</li>{/if}{/each}
			</TeamListLayout>
		{/if}
		{#if invitations.error || invitationsTimedOut}<p role="alert" class="mt-3 text-sm text-danger">
				Unable to load invitations. <button class="underline" onclick={() => invitationsRetry++}
					>Try again</button
				>
			</p>{/if}
		{#if invitations.status === 'CanLoadMore'}<Button
				variant="ghost"
				onclick={() => invitations.loadMore(50)}>Load more invitations</Button
			>{/if}
	{/snippet}
	{#snippet afterLists()}
		{#if confirmAction}
			<div class="rounded-xl border-hairline border-edge bg-surface p-4 shadow-card">
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
	{/snippet}
	{#snippet leaveContent()}
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
					>{#if leaveFailed}<Button variant="secondary" disabled={busy} onclick={() => leave(true)}
							>Discard changes and leave</Button
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
	{/snippet}
	{#snippet feedback()}
		{#if error}<p role="alert" class="text-sm text-danger">{error}</p>{/if}
	{/snippet}
</TeamLayout>
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
