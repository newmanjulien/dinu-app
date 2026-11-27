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
	let settled = $state(0);
	let completedMembership = $state<string>();
	const attempted = new Map<string, string>();
	const inFlight = new Set<string>();
	const hints = useReadQuery(api.accounts.setupHints, () =>
		canStart() &&
		session.workspaceAdmitted &&
		!session.blocked &&
		!session.closing &&
		!viewer().company.deletion
			? {}
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
		void settled;
		const transportGeneration = session.transportGeneration;
		const current = progress();
		const membership = viewer().membership;
		if (
			!current ||
			current.complete ||
			current.nextStep !== null ||
			session.blocked ||
			session.closing
		) {
			if (!current || current.nextStep !== null || session.blocked || session.closing)
				attempted.delete(membership.id);
			return;
		}
		if (completedMembership === membership.id) return;
		const membershipId = membership.id;
		const attemptKey = JSON.stringify([
			transportGeneration,
			retry,
			membership.role,
			current.contractId
		]);
		if (inFlight.has(membershipId) || attempted.get(membershipId) === attemptKey) return;
		attempted.set(membershipId, attemptKey);
		inFlight.add(membershipId);
		// The mutation rechecks the checklist; its successful result stops duplicate detection.
		untrack(() => {
			void (async () => {
				try {
					const complete = await client.mutation(api.accounts.completeSetup, { membershipId });
					if (complete && viewer().membership.id === membershipId)
						completedMembership = membershipId;
				} catch {
					// A reconnect or focus retries detection without interrupting the current task.
				} finally {
					inFlight.delete(membershipId);
					settled++;
				}
			})();
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
