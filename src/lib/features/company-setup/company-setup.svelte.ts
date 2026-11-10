import { getContext, onMount, setContext, untrack } from 'svelte';
import { useConvexClient } from 'convex-svelte';
import { api } from '../../../convex/_generated/api';
import { useReadQuery } from '$lib/auth/read-query.svelte';
import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';

const key = Symbol('company-setup');

/** Workspace-owned progress is shared by support and the setup prompt on every section. */
export function setCompanySetup(canStart: () => boolean) {
	const viewer = useViewer();
	const session = useViewerSession();
	const client = useConvexClient();
	let requested = $state(false);
	let retry = $state(0);
	let completedMembership = $state<string>();
	$effect(() => {
		if (canStart()) untrack(() => (requested = true));
	});
	const hints = useReadQuery(api.accounts.setupHints, () =>
		requested && !session.blocked && !session.closing && !viewer().company.deletionPending
			? { membershipId: viewer().membership.id }
			: 'skip'
	);
	$effect(() => {
		if (hints.data?.complete) completedMembership = viewer().membership.id;
	});
	onMount(() => {
		const refresh = () => {
			retry++;
			if (hints.error) hints.retry();
		};
		window.addEventListener('focus', refresh);
		return () => window.removeEventListener('focus', refresh);
	});
	$effect(() => {
		void retry;
		void session.transportGeneration;
		const progress = hints.data;
		if (
			!progress ||
			progress.complete ||
			progress.nextStep !== null ||
			session.blocked ||
			session.closing
		)
			return;
		// Idempotent mutation rechecks the entire checklist; no client completion flag is trusted.
		const membershipId = viewer().membership.id;
		untrack(() => {
			void client.mutation(api.accounts.completeSetup, { membershipId }).catch(() => {
				// A reconnect or focus retries detection without interrupting the current task.
			});
		});
	});
	return setContext(key, {
		get progress() {
			return hints.data;
		},
		get complete() {
			return completedMembership === viewer().membership.id || hints.data?.complete === true;
		}
	});
}

export const useCompanySetup = () => getContext<ReturnType<typeof setCompanySetup>>(key);
