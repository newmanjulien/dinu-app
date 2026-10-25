import type { Action } from 'svelte/action';
import { onMount, untrack } from 'svelte';
import { observeHomeWarming } from '$lib/document/runtime/render-perf';
import { getDocumentResources } from '$lib/document/runtime/resources.svelte';
import { getContractSnapshotCache } from './snapshot-cache';
import { rankCards } from './browser-storage';
import type { SavedContractCard } from './card';
import { afterStartupPaint } from '$lib/auth/startup-perf';

/** One viewport observer and one preparation policy for both Home and search. */
export function createVisibleContractWarming() {
	const resources = getDocumentResources();
	const cards = new Map<Element, SavedContractCard>();
	const visible = new Set<string>();
	const promoted = new Set<string>();
	let pending = $state(true);
	let enabled = $state(false);
	let busy = $state(false);
	let hidden = $state(false);
	let downloads = $state.raw<readonly string[]>([]);
	const device =
		typeof navigator === 'undefined'
			? undefined
			: (navigator as Navigator & {
					deviceMemory?: number;
					connection?: { saveData?: boolean };
				});
	const constrained = Boolean(
		device?.connection?.saveData ||
		(device?.deviceMemory && device.deviceMemory <= 4) ||
		(device?.hardwareConcurrency && device.hardwareConcurrency <= 4)
	);
	const downloadLimit = device?.connection?.saveData ? 1 : 4;
	let cancelStart: (() => void) | undefined;
	let releaseObservation: (() => void) | undefined;
	let destroyed = false;
	let observer: IntersectionObserver | undefined;
	let cache: ReturnType<typeof getContractSnapshotCache> | undefined;
	$effect(() => {
		const allowed = enabled && !pending && !busy && !hidden;
		const ids = resources?.preparationCandidates ?? [];
		// The eligible preparation target must still download when earlier candidates failed.
		const fetchIds = [...new Set([...ids, ...downloads])].slice(0, downloadLimit);
		untrack(() => {
			if (destroyed) return;
			if (resources) resources.backgroundEnabled = allowed;
			if (!allowed) cache?.pauseBackground();
			cache?.backgroundCandidates(fetchIds);
			if (!allowed) return;
			cache?.allowBackground();
			for (const id of ids) {
				const data = cache?.peek(id);
				if (data) resources?.prepare(data);
			}
		});
	});
	onMount(() => {
		let cooldown: ReturnType<typeof setTimeout> | undefined;
		const interaction = () => {
			busy = true;
			clearTimeout(cooldown);
			cooldown = setTimeout(() => (busy = false), 250);
		};
		const visibility = () => (hidden = document.visibilityState === 'hidden');
		visibility();
		const options = { passive: true, capture: true };
		for (const event of ['scroll', 'keydown', 'pointerdown'])
			window.addEventListener(event, interaction, options);
		document.addEventListener('visibilitychange', visibility);
		return () => {
			clearTimeout(cooldown);
			for (const event of ['scroll', 'keydown', 'pointerdown'])
				window.removeEventListener(event, interaction, options);
			document.removeEventListener('visibilitychange', visibility);
		};
	});
	let rankingScheduled = false;
	function candidates() {
		if (destroyed || rankingScheduled) return;
		rankingScheduled = true;
		queueMicrotask(() => {
			rankingScheduled = false;
			if (!destroyed) publishCandidates();
		});
	}
	function publishCandidates() {
		const ranked = rankCards(
			[...cards.entries()]
				.filter(([, card]) => visible.has(card._id))
				.sort(([a], [b]) =>
					a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
				)
				.map(([, card]) => card),
			[...promoted]
		);
		const ids = !enabled || pending ? [] : ranked;
		const selected = ids.slice(0, downloadLimit);
		if (
			downloads.length !== selected.length ||
			downloads.some((id, index) => id !== selected[index])
		)
			downloads = selected;
		// Filter failures before spending the single document preparation slot.
		resources?.candidates(constrained ? ids.filter((id) => promoted.has(id)) : ids, 1);
	}
	const observe: Action<HTMLElement, SavedContractCard> = (node, card) => {
		releaseObservation ??= observeHomeWarming();
		cache ??= getContractSnapshotCache();
		if (typeof IntersectionObserver !== 'undefined') {
			observer ??= new IntersectionObserver((entries) => {
				for (const entry of entries) {
					const card = cards.get(entry.target);
					if (!card) continue;
					if (entry.isIntersecting) {
						visible.add(card._id);
					} else {
						visible.delete(card._id);
					}
				}
				candidates();
			});
		}
		cards.set(node, card);
		if (observer) observer.observe(node);
		else {
			visible.add(card._id);
			candidates();
		}
		return {
			update(next) {
				card = next;
				cards.set(node, next);
				candidates();
			},
			destroy() {
				observer?.unobserve(node);
				cards.delete(node);
				visible.delete(card._id);
				promoted.delete(card._id);
				candidates();
			}
		};
	};
	return {
		observe,
		pending(value: boolean) {
			if (pending === value) return;
			pending = value;
			cancelStart?.();
			cancelStart = undefined;
			enabled = false;
			cache ??= getContractSnapshotCache();
			cache.pauseBackground();
			if (resources) resources.backgroundEnabled = false;
			if (!value) {
				cancelStart = afterStartupPaint(() => {
					const start = () => {
						if (destroyed || pending) return;
						enabled = true;
						candidates();
					};
					if ('requestIdleCallback' in window) {
						const idle = window.requestIdleCallback(start, { timeout: 2000 });
						cancelStart = () => window.cancelIdleCallback(idle);
					} else {
						const timer = setTimeout(start, 100);
						cancelStart = () => clearTimeout(timer);
					}
				});
			}
			candidates();
		},
		warm(id: string) {
			resources?.promote(id);
			promoted.add(id);
			visible.add(id);
			candidates();
		},
		cool(id: string) {
			if (promoted.delete(id)) candidates();
		},
		destroy() {
			destroyed = true;
			cancelStart?.();
			cache?.pauseBackground();
			if (resources) resources.backgroundEnabled = false;
			releaseObservation?.();
			observer?.disconnect();
			cache?.backgroundCandidates([]);
			cards.clear();
			visible.clear();
			promoted.clear();
			resources?.candidates([]);
		}
	};
}
