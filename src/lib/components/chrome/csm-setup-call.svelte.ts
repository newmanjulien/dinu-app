import { untrack } from 'svelte';
import { useConvexClient } from 'convex-svelte';
import { api } from '../../../convex/_generated/api';
import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';

/** Request background repair at admission and on return; sync state has no header UI. */
export function useSetupCallRefresh(enabled: () => boolean) {
	const client = useConvexClient();
	const viewer = useViewer();
	const session = useViewerSession();
	const scope = $derived(
		enabled() && session.workspaceAdmitted && session.preparedSessionId
			? {
					identity: JSON.stringify([
						session.preparedSessionId,
						viewer().profile.id,
						viewer().membership.id,
						viewer().company.id
					]),
					membershipId: viewer().membership.id
				}
			: undefined
	);
	$effect(() => {
		const target = scope;
		const generation = session.transportGeneration;
		if (!target) return;
		return untrack(() => {
			let disposed = false;
			let connected = client.connectionState().isWebSocketConnected;
			let lastRevisit = 0;
			const revisit = () => {
				if (
					disposed ||
					scope?.identity !== target.identity ||
					generation !== session.transportGeneration ||
					document.visibilityState !== 'visible' ||
					!connected
				)
					return;
				const now = Date.now();
				if (now - lastRevisit < 60_000) return;
				lastRevisit = now;
				void client
					.mutation(api.csmSetupAppointments.revisit, { membershipId: target.membershipId })
					.catch(() => {});
			};
			const releaseConnection = client.subscribeToConnectionState((connection) => {
				const reconnected = !connected && connection.isWebSocketConnected;
				connected = connection.isWebSocketConnected;
				if (reconnected) revisit();
			});
			document.addEventListener('visibilitychange', revisit);
			window.addEventListener('focus', revisit);
			revisit();
			return () => {
				disposed = true;
				releaseConnection();
				document.removeEventListener('visibilitychange', revisit);
				window.removeEventListener('focus', revisit);
			};
		});
	});
}
