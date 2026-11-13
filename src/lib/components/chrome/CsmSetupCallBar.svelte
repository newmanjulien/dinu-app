<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import type { Viewer } from '$lib/auth/viewer-session.svelte';
	import NoticeBar from './NoticeBar.svelte';

	let { call }: { call: Viewer['company']['setupCall'] } = $props();
	let now = $state(Date.now());
	const notice = $derived(
		call && (call.state === 'cancelled' || Date.parse(call.end) > now) ? call : null
	);
	$effect(() => {
		void call;
		now = Date.now();
	});
	$effect(() => {
		if (!call || call.state === 'cancelled') return;
		const remaining = Date.parse(call.end) - now;
		if (remaining <= 0) return;
		const timer = setTimeout(() => (now = Date.now()), Math.min(2_147_483_647, remaining));
		return () => clearTimeout(timer);
	});
	onMount(() => {
		const update = () => (now = Date.now());
		window.addEventListener('focus', update);
		document.addEventListener('visibilitychange', update);
		return () => {
			window.removeEventListener('focus', update);
			document.removeEventListener('visibilitychange', update);
		};
	});
	const dateFormat = new Intl.DateTimeFormat('en', {
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
	const label = $derived(notice ? dateFormat.format(new Date(notice.start)) : '');
</script>

{#if notice}
	<NoticeBar
		action={notice.state === 'cancelled' && page.route.id !== '/(workspace)/template'
			? { label: 'Reschedule', href: '/template' }
			: undefined}
	>
		{#if notice.state === 'scheduled'}
			You booked a call with our team so we can help set up your template. Your call is on <time
				datetime={notice.start}>{label}</time
			>.
		{:else}
			Your setup call was cancelled. Please reschedule so we can help set up your template.
		{/if}
	</NoticeBar>
{/if}
