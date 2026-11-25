import { onMount, untrack } from 'svelte';
import { browserTimeZone } from './csm-time';

const MAX_TIMEOUT_MS = 2_147_483_647;
const BOUNDARY_PAD_MS = 50;

/**
 * Reactive wall clock that sleeps until the exact next boundary where a time-sensitive display
 * changes, and re-syncs when inputs change, the tab regains visibility/focus, or the timezone shifts.
 */
export function useBoundaryClock(
	getNextAt: (now: number, timeZone: string) => number | null,
	getSyncKey?: () => unknown
) {
	let now = $state(Date.now());
	let timeZone = $state(browserTimeZone());

	const nextAt = $derived(getNextAt(now, timeZone));

	function sync(force = false) {
		const currentNow = Date.now();
		const currentZone = browserTimeZone();
		if (
			force ||
			currentZone !== timeZone ||
			currentNow < now ||
			(nextAt !== null && currentNow >= nextAt)
		) {
			now = currentNow;
			timeZone = currentZone;
		}
	}

	let initialized = false;
	$effect(() => {
		if (!getSyncKey) return;
		getSyncKey();
		if (!initialized) {
			initialized = true;
			return;
		}
		untrack(() => sync(true));
	});

	$effect(() => {
		const target = nextAt;
		if (target === null) return;
		const delay = Math.min(MAX_TIMEOUT_MS, Math.max(1, target - now) + BOUNDARY_PAD_MS);
		const timer = setTimeout(() => sync(true), delay);
		return () => clearTimeout(timer);
	});

	onMount(() => {
		const onFocus = () => sync();
		const onVisible = () => {
			if (!document.hidden) sync();
		};
		window.addEventListener('focus', onFocus);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			window.removeEventListener('focus', onFocus);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	return {
		get now() {
			return now;
		},
		get timeZone() {
			return timeZone;
		}
	};
}
