<script lang="ts">
	import { useWorkspaceReadSnapshots } from '$lib/auth/workspace-read-snapshots.svelte';
	import type { WorkspaceReadRows } from '$lib/auth/workspace-read-storage';
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
	import { Button, ConfirmModal } from '$lib/ui';
	const client = useConvexClient();
	const session = useViewerSession();
	const viewer = useViewer();
	const reads = useWorkspaceReadSnapshots();
	const returnTo = $derived(page.url.searchParams.get('returnTo'));
	const invitationReturn = $derived(
		returnTo && new URL(localReturn(returnTo), page.url).pathname === '/invitation'
			? localReturn(returnTo)
			: null
	);
	const membershipId = viewer().membership.id;
	const canManage = $derived(viewer().permissions.manageMembers);
	const isOwner = $derived(viewer().membership.isOwner);
	let now = $state(Date.now());
	onMount(() => {
		now = Date.now();
		void reads?.hydrate('colleagues');
		if (canManage) void reads?.hydrate('invitations');
		const timer = setInterval(() => (now = Date.now()), 60_000);
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
	let colleaguePage = $state.raw<WorkspaceReadRows['colleagues']>();
	let invitationPage = $state.raw<WorkspaceReadRows['invitations']>();
	// Paging keeps the historical first page; merged results never replace that snapshot.
	let colleaguesPaged = false;
	let invitationsPaged = false;
	$effect(() => {
		if (colleagues.error) {
			untrack(() => {
				colleaguePage = undefined;
				reads?.invalidate('colleagues');
			});
			return;
		}
		if (colleagues.status === 'LoadingFirstPage') return;
		const rows = colleagues.results;
		const hasMore = colleagues.status !== 'Exhausted';
		untrack(() => {
			colleaguePage = rows;
			if (!colleaguesPaged) reads?.confirm('colleagues', rows, hasMore);
		});
	});
	$effect(() => {
		if (!canManage || invitations.error) {
			untrack(() => {
				invitationPage = undefined;
				reads?.invalidate('invitations');
			});
			return;
		}
		untrack(() => void reads?.hydrate('invitations'));
		if (invitations.status === 'LoadingFirstPage') return;
		const rows = invitations.results;
		const hasMore = invitations.status !== 'Exhausted';
		untrack(() => {
			invitationPage = rows;
			if (!invitationsPaged) reads?.confirm('invitations', rows, hasMore);
		});
	});
	const colleagueRows = $derived(
		colleagues.error ? [] : (colleaguePage ?? reads?.get('colleagues')?.rows ?? [])
	);
	const invitationRows = $derived(
		!canManage || invitations.error ? [] : (invitationPage ?? reads?.get('invitations')?.rows ?? [])
	);
	const colleaguesCurrent = $derived(!colleagues.error && colleagues.status !== 'LoadingFirstPage');
	const invitationsCurrent = $derived(
		canManage && !invitations.error && invitations.status !== 'LoadingFirstPage'
	);
	function loadMoreColleagues() {
		if (!colleaguesCurrent || colleagues.status !== 'CanLoadMore') return;
		colleaguesPaged = true;
		colleagues.loadMore(50);
	}
	function loadMoreInvitations() {
		if (!invitationsCurrent || invitations.status !== 'CanLoadMore') return;
		invitationsPaged = true;
		invitations.loadMore(50);
	}
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
			!colleagueRows.length &&
			!colleagues.error &&
			!colleaguesTimedOut
	);
	const invitationsLoading = $derived(
		canManage &&
			invitations.status === 'LoadingFirstPage' &&
			!invitationRows.length &&
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
	let leaveError = $state<string | null>(null);
	let confirmError = $state<string | null>(null);
	let confirmAction = $state<{
		title: string;
		message: string;
		confirmLabel: string;
		destructive?: boolean;
		run: () => Promise<unknown>;
	}>();
	let alive = true;
	onDestroy(() => (alive = false));
	function requestConfirmation(action: NonNullable<typeof confirmAction>) {
		confirmError = null;
		confirmAction = action;
	}
	async function run(action: () => Promise<unknown>, confirmation = false) {
		if (busy || session.blocked) return;
		busy = true;
		if (confirmation) confirmError = null;
		else error = '';
		try {
			await action();
			reads?.invalidate('colleagues', 'invitations');
			if (alive && confirmation) confirmAction = undefined;
		} catch (e) {
			if (alive) {
				const message = e instanceof Error ? e.message : 'Unable to update your company.';
				if (confirmation) confirmError = message;
				else error = message;
			}
		} finally {
			if (alive) busy = false;
		}
	}
	async function leave(discard = false) {
		if (busy) return;
		busy = true;
		leaveError = null;
		try {
			await session.exitCompany(
				() => client.mutation(api.companies.leave, { membershipId }),
				discard
			);
		} catch (e) {
			if (alive) {
				leaveFailed = true;
				leaveError = e instanceof Error ? e.message : 'Unable to leave your company.';
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
			reads?.invalidate('invitations');
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
				{#each colleagueRows as person (person.membershipId)}
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
									disabled={busy || session.blocked || !colleaguesCurrent}
									onclick={() =>
										requestConfirmation({
											title: 'Transfer ownership?',
											message: `Transfer company ownership to ${person.name || person.email}? They will manage company ownership.`,
											confirmLabel: 'Transfer ownership',
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
									disabled={busy || session.blocked || !colleaguesCurrent}
									onclick={() =>
										requestConfirmation({
											title: 'Remove colleague?',
											message: `Remove ${person.name || person.email} from your company? Their contracts will stay with the company.`,
											confirmLabel: 'Remove colleague',
											destructive: true,
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
		{#if colleagues.status === 'CanLoadMore'}<Button variant="ghost" onclick={loadMoreColleagues}
				>Load more colleagues</Button
			>{/if}
	{/snippet}
	{#snippet invitationsContent()}
		{#if invitationsLoading}
			<TeamRowsSkeleton invitations />
		{:else}
			<TeamListLayout>
				{#each invitationRows as invitation (invitation.id)}
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
								disabled={busy || session.blocked || !invitationsCurrent}
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
								disabled={busy || session.blocked || !invitationsCurrent}
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
		{#if invitations.status === 'CanLoadMore'}<Button variant="ghost" onclick={loadMoreInvitations}
				>Load more invitations</Button
			>{/if}
	{/snippet}
	{#snippet leaveContent()}
		{#if isOwner}<p class="mt-2 text-sm text-ink-muted">
				Transfer ownership to a colleague before leaving or deleting your account.
			</p>
		{:else}
			<p class="mt-2 text-sm text-ink-muted">
				Your contracts stay with {viewer().company.name}. You’ll need a new invitation to return.
			</p>
			<Button
				variant="ghost"
				disabled={busy || session.blocked}
				onclick={() => {
					leaveError = null;
					leaveFailed = false;
					leaving = true;
				}}>Leave company</Button
			>
		{/if}
	{/snippet}
	{#snippet feedback()}
		{#if error}<p role="alert" class="text-sm text-danger">{error}</p>{/if}
	{/snippet}
</TeamLayout>
{#if confirmAction}
	<ConfirmModal
		title={confirmAction.title}
		message={confirmAction.message}
		confirmLabel={confirmAction.confirmLabel}
		destructive={confirmAction.destructive}
		confirmDisabled={session.blocked}
		{busy}
		error={confirmError}
		onConfirm={() => {
			if (confirmAction) return run(confirmAction.run, true);
		}}
		onCancel={() => {
			confirmAction = undefined;
			confirmError = null;
		}}
	/>
{/if}
{#if leaving && !isOwner}
	<ConfirmModal
		title="Leave company?"
		message={`Leave ${viewer().company.name}? We’ll save your pending changes first.`}
		confirmLabel="Save and leave"
		confirmDisabled={session.blocked}
		pendingLabel="Saving and leaving…"
		secondaryActionLabel={leaveFailed ? 'Discard changes and leave' : undefined}
		secondaryPendingLabel="Leaving…"
		secondaryDestructive
		{busy}
		error={leaveError}
		onConfirm={() => leave()}
		onSecondaryAction={() => leave(true)}
		onCancel={() => {
			leaving = false;
			leaveFailed = false;
			leaveError = null;
		}}
	/>
{/if}
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
