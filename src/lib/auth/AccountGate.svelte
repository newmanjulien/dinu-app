<script lang="ts">
	import { useAuth, useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '../../convex/_generated/api';
	import { discardMembershipDrafts } from '$lib/contract/draft-recovery.svelte';
	import { setCacheIdentity } from '$lib/contract/browser-storage';
	import {
		contractCacheResources,
		releaseContractSnapshotCache
	} from '$lib/contract/snapshot-cache';
	import { setAccount, useViewerSession, type AccountViewer } from './viewer-session.svelte';
	import { AccountPreparation } from './account-preparation';
	import { ReadAttempt, waitForRead } from './attempt';
	import { recordStartup } from './startup-perf';
	import { useStartupData } from './startup-data';
	import { untrack, onDestroy, type Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
	const client = useConvexClient();
	const auth = useAuth();
	const session = useViewerSession();
	session.registerResources(contractCacheResources);
	const viewer = useQuery(api.profiles.viewer, () => (auth.isAuthenticated ? {} : 'skip'));
	const startup = useStartupData();
	let receivedViewer = $state(false);
	const data = $derived.by(() => {
		if (viewer.data !== undefined) return viewer.data;
		if (receivedViewer || !auth.isAuthenticated || viewer.error) return undefined;
		const initial = startup()?.viewer;
		return initial && !initial.needsInitialization ? initial : undefined;
	});
	$effect(() => {
		if (auth.isAuthenticated && (viewer.data !== undefined || viewer.error)) receivedViewer = true;
	});
	let account = $state.raw<AccountViewer>();
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
			if (alive && current === epoch && session.transportGeneration === transportGeneration)
				error = e instanceof Error ? e.message : 'Unable to initialize your account.';
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
		const failure = (generation === nextGeneration ? error : '') || viewer.error?.message || '';
		const ready = Boolean(auth.isAuthenticated && value && !value.needsInitialization && !failure);
		untrack(() => {
			if (value) {
				if (
					account?.profile.id !== value.profile.id ||
					account?.membership?.id !== value.membership?.id
				) {
					releaseContractSnapshotCache();
					setCacheIdentity(
						value.membership
							? { profileId: value.profile.id, membershipId: value.membership.id }
							: null
					);
				}
				if (account?.membership && account.membership.id !== value.membership?.id && session.userId)
					discardMembershipDrafts(session.userId, account.membership.id);
				account = value;
			}
			if (ready && !recorded) {
				recordStartup('account-ready');
				recorded = true;
			}
			session.reportAccount(ready, failure);
		});
	});
</script>

{@render children()}
