<script lang="ts">
	import { onMount } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import type { FunctionReturnType } from 'convex/server';
	import { api } from '../../../convex/_generated/api';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import Button from '$lib/ui/Button.svelte';
	import { useCsmDialog } from './csm-dialog.svelte';

	let { onReady }: { onReady: () => void } = $props();
	const client = useConvexClient(),
		viewer = useViewer(),
		session = useViewerSession();
	const dialog = useCsmDialog();
	type Notice = FunctionReturnType<typeof api.csmSetupAppointments.current>;
	let notice = $state<Notice>(null);
	let now = $state(Date.now());
	let connected = $state(false);
	let revisit: (() => void) | undefined;
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	const dateFormat = new Intl.DateTimeFormat('en', {
		timeZone: zone,
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
	const label = $derived(notice ? dateFormat.format(new Date(notice.start)) : '');
	const displayState = $derived(
		!notice
			? undefined
			: notice.state === 'cancelled'
				? 'cancelled'
				: Date.parse(notice.end) <= now
					? undefined
					: notice.state === 'scheduled' &&
						  connected &&
						  notice.freshUntil !== null &&
						  notice.freshUntil > now
						? 'scheduled'
						: 'checking'
	);

	onMount(() => {
		onReady();
		const membershipId = viewer().membership.id,
			companyId = viewer().company.id,
			profileId = viewer().profile.id,
			sessionId = session.preparedSessionId,
			generation = session.transportGeneration;
		let disposed = false;
		const current = () =>
			!disposed &&
			!session.blocked &&
			!session.closing &&
			sessionId === session.preparedSessionId &&
			generation === session.transportGeneration &&
			membershipId === viewer().membership.id &&
			companyId === viewer().company.id &&
			profileId === viewer().profile.id &&
			viewer().membership.role === 'admin' &&
			!viewer().company.deletionPending;
		let lastRevisit = 0;
		revisit = () => {
			now = Date.now();
			if (
				!current() ||
				document.visibilityState !== 'visible' ||
				!connected ||
				now - lastRevisit < 60_000
			)
				return;
			lastRevisit = now;
			void client.mutation(api.csmSetupAppointments.revisit, { membershipId }).catch(() => {});
		};
		connected = client.connectionState().isWebSocketConnected;
		const releaseConnection = client.subscribeToConnectionState((connection) => {
			if (!current()) return;
			const reconnected = !connected && connection.isWebSocketConnected;
			connected = connection.isWebSocketConnected;
			if (reconnected) revisit?.();
		});
		const release = client.onUpdate(
			api.csmSetupAppointments.current,
			{ membershipId },
			(row) => {
				if (current()) {
					notice = row;
					now = Date.now();
				}
			},
			() => {
				if (current()) notice = null;
			}
		);
		const wake = () => revisit?.();
		document.addEventListener('visibilitychange', wake);
		window.addEventListener('focus', wake);
		wake();
		return () => {
			disposed = true;
			revisit = undefined;
			release();
			releaseConnection();
			document.removeEventListener('visibilitychange', wake);
			window.removeEventListener('focus', wake);
		};
	});
	$effect(() => {
		if (!notice || notice.state === 'cancelled') return;
		const deadlines = [Date.parse(notice.end), notice.freshUntil ?? 0].filter((t) => t > now);
		if (!deadlines.length) return;
		const timer = setTimeout(
			() => {
				now = Date.now();
				revisit?.();
			},
			Math.min(2_147_483_647, Math.max(1, Math.min(...deadlines) - Date.now()))
		);
		return () => clearTimeout(timer);
	});
</script>

{#if displayState && notice}
	<div
		class="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-t-[length:var(--surface-border-width)] border-line bg-[color-mix(in_srgb,var(--color-accent)_5%,white)] px-3 py-2.5 text-[12.5px] font-normal leading-relaxed text-ink sm:px-5"
	>
		<p class="min-w-0 flex-1 basis-[400px]" role="status" aria-live="polite" aria-atomic="true">
			{#if displayState === 'scheduled'}
				You booked a call with our team so we can help get your contract set up. Your call is on <time
					datetime={notice.start}>{label}</time
				>.
			{:else if displayState === 'cancelled'}
				Your setup call was cancelled. Please reschedule so we can help get your contract set up.
			{:else}
				We’re checking the latest details for your contract setup call.
			{/if}
		</p>
		{#if displayState === 'cancelled'}
			<Button
				variant="secondary"
				disabled={!connected}
				aria-haspopup="dialog"
				onclick={(event) => {
					if (notice && event.currentTarget instanceof HTMLButtonElement)
						dialog.replace(
							{ appointmentId: notice.id, currentUid: notice.currentUid },
							event.currentTarget
						);
				}}
				class="h-[31px] rounded-[7px]! self-center px-[9.5px] py-1 text-[11.75px] shadow-none not-disabled:not-aria-disabled:hover:bg-field-hover disabled:bg-field-hover"
				>Reschedule</Button
			>
		{/if}
	</div>
{/if}
