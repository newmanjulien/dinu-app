import { getContext, onMount, setContext, untrack } from 'svelte';
import { useConvexClient } from 'convex-svelte';
import { api } from '../../../convex/_generated/api';
import { useReadQuery } from '$lib/auth/read-query.svelte';
import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
import { useStartupSetup } from '$lib/auth/startup-data';

const key = Symbol('company-setup');

/** Workspace-owned progress is shared by support and the setup prompt on every section. */
export function setCompanySetup(canStart: () => boolean = () => true) {
	const viewer = useViewer();
	const session = useViewerSession();
	const startup = useStartupSetup();
	const client = useConvexClient();
	let retry = $state(0);
	let completedMembership = $state<string>();
	const hints = useReadQuery(api.accounts.setupHints, () =>
		canStart() &&
		session.workspaceAdmitted &&
		!session.blocked &&
		!session.closing &&
		!viewer().company.deletion
			? { membershipId: viewer().membership.id }
			: 'skip'
	);
	const progress = () => {
		const initial = startup();
		return (
			hints.data ??
			(initial?.membershipId === viewer().membership.id ? initial.progress : undefined)
		);
	};
	$effect(() => {
		if (progress()?.complete) completedMembership = viewer().membership.id;
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
		const current = progress();
		if (
			!current ||
			current.complete ||
			current.nextStep !== null ||
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
			return progress();
		},
		get resolved() {
			return progress() !== undefined || hints.error !== undefined;
		},
		get error() {
			return progress() === undefined && hints.error !== undefined;
		},
		retry: () => hints.retry(),
		get loading() {
			return hints.isLoading && progress() === undefined;
		},
		get complete() {
			return completedMembership === viewer().membership.id || progress()?.complete === true;
		}
	});
}

export const useCompanySetup = () => getContext<ReturnType<typeof setCompanySetup>>(key);
