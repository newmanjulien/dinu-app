<script lang="ts">
	import { workspaceReadResources } from './workspace-read-storage';
	import { useAccountContext } from './account-context.svelte';
	import { useAuth, useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '../../convex/_generated/api';
	import { createCacheScope } from '$lib/contract/browser-storage';
	import { contractCacheResources, replaceContractCacheScope } from '$lib/contract/snapshot-cache';
	import { setAccount, useViewerSession, type AccountViewer } from './viewer-session.svelte';
	import { getErrorMessage, isAccountDeletedError } from './account-errors';
	import { AccountPreparation } from './account-preparation';
	import { ReadAttempt, waitForRead } from './attempt';
	import { recordStartup } from './startup-perf';
	import { useStartupData } from './startup-data';
	import { untrack, onDestroy, type Snippet } from 'svelte';
	let { children }: { children?: Snippet } = $props();
	const client = useConvexClient();
	const publication = useAccountContext();
	const auth = useAuth();
	const session = useViewerSession();
	session.registerResources(contractCacheResources);
	session.registerResources(workspaceReadResources);
	const viewer = useQuery(api.accounts.viewer, {});
	const startup = useStartupData();
	let receivedViewer = $state(false);
	const data = $derived.by(() => {
		if (!auth.isAuthenticated) return undefined;
		if (viewer.data !== undefined) return viewer.data;
		if (receivedViewer || !auth.isAuthenticated || viewer.error) return undefined;
		const initial = startup()?.viewer;
		return initial && !initial.needsInitialization ? initial : undefined;
	});
	$effect(() => {
		if (auth.isAuthenticated && (viewer.data !== undefined || viewer.error)) receivedViewer = true;
	});
	let account = $state.raw<AccountViewer>();
	let accountUserId: string | null = null;
	setAccount(() => account);
	const preparation = new AccountPreparation();
	let error = $state('');
	let generation = -1;
	let epoch = 0;
	let preparationAttempt: ReadAttempt | undefined;
	let alive = true;
	let recorded = false;
	onDestroy(() => {
		alive = false;
		preparationAttempt?.abort();
		epoch++;
	});
	async function initialize(transportGeneration: number) {
		const current = ++epoch;
		preparationAttempt?.abort();
		const read = new ReadAttempt(15_000);
		preparationAttempt = read;
		generation = transportGeneration;
		error = '';
		try {
			await waitForRead(client.mutation(api.profiles.initialize, {}), read.signal);
		} catch (e) {
			if (alive && current === epoch && session.transportGeneration === transportGeneration) {
				if (isAccountDeletedError(e)) {
					const sessionId = session.preparedSessionId;
					const userId = session.userId;
					if (sessionId && userId) {
						void session.completeAccountDeletion({ sessionId, userId });
						return;
					}
				}
				error = getErrorMessage(e, 'Unable to initialize your account.');
			}
		} finally {
			read.complete();
		}
	}
	$effect(() => {
		const authenticated = auth.isAuthenticated;
		const nextGeneration = session.transportGeneration;
		const value = viewer.data;
		untrack(() => {
			if (authenticated)
				void preparation.initialize(value, nextGeneration, () => initialize(nextGeneration));
		});
	});
	$effect(() => {
		const value = data;
		const nextGeneration = session.transportGeneration;
		const deleted = auth.isAuthenticated && isAccountDeletedError(viewer.error);
		const failure =
			!auth.isAuthenticated || deleted
				? ''
				: (generation === nextGeneration ? error : '') ||
					(viewer.error ? getErrorMessage(viewer.error, viewer.error.message) : '');
		const ready = Boolean(
			auth.isAuthenticated && value && !value.needsInitialization && !failure && !deleted
		);
		untrack(() => {
			if (deleted) {
				const sessionId = session.preparedSessionId;
				const userId = session.userId;
				if (sessionId && userId) void session.completeAccountDeletion({ sessionId, userId });
				return;
			}
			if (
				account?.membership &&
				accountUserId &&
				(value === null ||
					(value !== undefined &&
						(account.profile.id !== value.profile.id ||
							account.membership.id !== value.membership?.id ||
							account.company?.id !== value.company?.id)))
			)
				session.captureMembershipRetirement({
					userId: accountUserId,
					membershipId: account.membership.id,
					sessionId: session.preparedSessionId ?? undefined
				})();
			if (auth.isAuthenticated && viewer.error) workspaceReadResources.clear();
			if (value) {
				if (
					account?.profile.id !== value.profile.id ||
					account?.membership?.id !== value.membership?.id
				) {
					replaceContractCacheScope(
						createCacheScope(
							value.membership && session.userId
								? {
										userId: session.userId,
										profileId: value.profile.id,
										membershipId: value.membership.id
									}
								: null
						)
					);
				}
				account = value;
				accountUserId = session.userId;
				if (publication) publication.account = value;
			}
			if (publication && auth.isAuthenticated && viewer.error) publication.rejected = true;
			else if (publication && value !== undefined) publication.rejected = false;
			if (value === null) {
				replaceContractCacheScope(createCacheScope(null));
				account = undefined;
				accountUserId = null;
				if (publication) publication.account = null;
			}
			if (ready && !recorded) {
				recordStartup('account-ready');
				recorded = true;
			}
			session.reportAccount(ready, failure);
		});
	});
</script>

{@render children?.()}
