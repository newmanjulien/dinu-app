<script lang="ts">
	import { page } from '$app/state';
	import { useClerkContext } from 'svelte-clerk';
	import { untrack, type Snippet } from 'svelte';
	import { useViewerSession } from './viewer-session.svelte';
	import { setStartupData, type StartupData } from './startup-data';
	let { children }: { children: Snippet } = $props();
	const clerk = useClerkContext();
	const session = useViewerSession();
	let data = $state.raw<StartupData | null>(null);
	let generation = $state<number>();
	$effect(() => {
		if (session.prepared && generation === undefined) generation = session.transportGeneration;
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
