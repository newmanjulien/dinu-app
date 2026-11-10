<script lang="ts">
	import { page } from '$app/state';
	import { useClerkContext } from 'svelte-clerk';
	import { untrack, type Snippet } from 'svelte';
	import { useViewerSession } from './viewer-session.svelte';
	import {
		setStartupData,
		setStartupHome,
		type StartupData,
		type StartupHome
	} from './startup-data';
	let { children }: { children: Snippet } = $props();
	const clerk = useClerkContext();
	const session = useViewerSession();
	let data = $state.raw<StartupData | null>(null);
	let generation = $state<number>();
	let home = $state.raw<StartupHome | null>(null);
	$effect(() => {
		if (session.preparedSessionId && generation === undefined)
			generation = session.transportGeneration;
	});
	$effect(() => {
		const request = page.data.startup;
		let active = true;
		untrack(() => (data = null));
		if (request)
			void Promise.resolve(request)
				.then((result) => {
					if (active) data = result;
				})
				.catch(() => {});
		return () => {
			active = false;
		};
	});
	$effect(() => {
		const request = page.data.startupHome;
		let active = true;
		untrack(() => (home = null));
		if (request)
			void Promise.resolve(request)
				.then((result) => {
					if (active) home = result;
				})
				.catch(() => {});
		return () => {
			active = false;
		};
	});
	setStartupHome(() =>
		home &&
		generation === session.transportGeneration &&
		!session.closing &&
		home.sessionId === clerk.session?.id &&
		home.userId === clerk.user?.id
			? home
			: null
	);
	// A server snapshot can assist the first admission only, never a recovered transport.
	setStartupData(() =>
		data &&
		generation === session.transportGeneration &&
		!session.closing &&
		data.sessionId === clerk.session?.id &&
		data.userId === clerk.user?.id
			? data
			: null
	);
</script>

{@render children()}
