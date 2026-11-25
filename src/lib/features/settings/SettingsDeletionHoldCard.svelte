<script lang="ts">
	import { onDestroy } from 'svelte';
	import { useClerkContext } from 'svelte-clerk';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import { getErrorMessage } from '$lib/auth/account-errors';
	import { useViewerSession, type Viewer } from '$lib/auth/viewer-session.svelte';
	import { Button } from '$lib/ui';
	import DeleteAccountModal from './DeleteAccountModal.svelte';
	import SettingsCard from './SettingsCard.svelte';

	type Props = {
		deletion: NonNullable<Viewer['company']['deletion']>;
		companyName: string;
	};

	let { deletion, companyName }: Props = $props();
	const client = useConvexClient();
	const clerk = useClerkContext();
	const viewerSession = useViewerSession();

	let alive = true;
	onDestroy(() => {
		alive = false;
	});

	let cancelling = $state(false);
	let errorText = $state<string | null>(null);
	let retryModalOpen = $state(false);

	const canResolve = $derived(deletion.status === 'deleting' && deletion.ownedByViewer);

	async function cancelDeletion() {
		if (cancelling || !canResolve) return;
		const sessionId = clerk.session?.id;
		const userId = clerk.user?.id;
		cancelling = true;
		errorText = null;
		try {
			const outcome = await client.action(api.accountDeletionActions.cancelHold, {});
			if (outcome === 'deleted' && sessionId && userId) {
				await viewerSession.completeAccountDeletion({ sessionId, userId });
			}
		} catch (error) {
			if (alive && viewerSession.phase !== 'completing-deletion' && !viewerSession.closing) {
				errorText = getErrorMessage(
					error,
					'Unable to cancel deletion right now. Please try again.'
				);
			}
		} finally {
			if (alive && viewerSession.phase !== 'completing-deletion' && !viewerSession.closing)
				cancelling = false;
		}
	}
</script>

<SettingsCard
	title={canResolve ? 'Account deletion needs confirmation' : 'Company deletion in progress'}
	description={canResolve
		? `Company activity for ${companyName} is paused because your last deletion attempt could not be confirmed. Retry deletion to finish, or cancel it to resume normal activity.`
		: `Company activity for ${companyName} is paused while permanent deletion finishes.`}
>
	{#if errorText}
		<p role="alert" class="mt-3 text-[0.74rem] leading-5 text-danger">{errorText}</p>
	{/if}

	{#snippet footer()}
		<p>
			{canResolve
				? 'Other settings stay paused until deletion finishes or is cancelled.'
				: 'This workspace is locked while cleanup completes.'}
		</p>
	{/snippet}

	{#snippet action()}
		{#if canResolve}
			<div class="flex flex-wrap items-center gap-2">
				<Button variant="secondary" disabled={cancelling} onclick={cancelDeletion}>
					{cancelling ? 'Cancelling...' : 'Cancel deletion'}
				</Button>
				<Button
					disabled={cancelling}
					class="bg-danger text-white not-disabled:not-aria-disabled:hover:bg-danger-hover"
					onclick={() => {
						errorText = null;
						retryModalOpen = true;
					}}
				>
					Retry deletion
				</Button>
			</div>
		{/if}
	{/snippet}
</SettingsCard>

{#if canResolve}
	<DeleteAccountModal
		open={retryModalOpen}
		retryHold
		onClose={() => {
			retryModalOpen = false;
		}}
	/>
{/if}
