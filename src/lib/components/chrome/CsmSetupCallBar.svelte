<script lang="ts">
	import { page } from '$app/state';
	import type { Viewer } from '$lib/auth/viewer-session.svelte';
	import NoticeBar from './NoticeBar.svelte';
	import { useBoundaryClock } from './csm-clock.svelte';
	import { formatSetupCallSchedule, nextSetupCallUpdateAt } from './csm-time';

	let { call }: { call: Viewer['company']['setupCall'] } = $props();

	const callState = $derived(call?.state ?? null);
	const callStart = $derived(call?.start ?? null);
	const callEnd = $derived(call?.end ?? null);

	const clock = useBoundaryClock(
		(now, timeZone) =>
			callState === 'scheduled' && callStart && callEnd
				? nextSetupCallUpdateAt(callEnd, now, timeZone)
				: null,
		() => `${callState ?? ''}:${callStart ?? ''}:${callEnd ?? ''}`
	);

	const notice = $derived(
		callState &&
			callStart &&
			callEnd &&
			(callState === 'cancelled' || Date.parse(callEnd) > clock.now)
			? { state: callState, start: callStart, end: callEnd }
			: null
	);
	const schedule = $derived(
		notice?.state === 'scheduled'
			? formatSetupCallSchedule(notice.start, clock.now, clock.timeZone)
			: null
	);
</script>

{#if notice}
	<NoticeBar
		action={notice.state === 'cancelled' && page.route.id !== '/(workspace)/template/setup'
			? { label: 'Reschedule', href: '/template/setup' }
			: undefined}
	>
		{#if schedule}
			You booked a call with our team so we can help set up your template. Your call is {schedule.relative
				? ''
				: 'on '}<time datetime={notice.start}>{schedule.label}</time>.
		{:else}
			Your setup call was cancelled. Please reschedule so we can help set up your template.
		{/if}
	</NoticeBar>
{/if}
