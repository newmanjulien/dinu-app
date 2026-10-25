import { afterNavigate, beforeNavigate, onNavigate } from '$app/navigation';
import { page } from '$app/state';
import { getContext, onMount, setContext, tick, untrack } from 'svelte';
import { describeRoute } from '$lib/auth/routes';
import type { ContractViewerState } from './viewer.svelte';

const key = Symbol('document-navigation');
interface Destination {
	href: string;
	scroll: { x: number; y: number } | null;
	hash: string;
}

/** Replay the router's intended restoration once deferred document DOM exists. */
class DocumentNavigation {
	pending = $state.raw<Destination>();
	#preserve = new Set<string>();

	preserve(href: string) {
		this.#preserve.add(href);
		return () => this.#preserve.delete(href);
	}
	isPreserved(href: string) {
		return this.#preserve.has(href);
	}
	cancel() {
		this.pending = undefined;
	}
	visible(viewer: ContractViewerState) {
		const destination = this.pending;
		if (!destination || page.url.href !== destination.href || !viewer.visible || !viewer.prepared)
			return;
		void tick().then(() => {
			if (
				this.pending !== destination ||
				page.url.href !== destination.href ||
				!viewer.visible ||
				!viewer.prepared
			)
				return;
			this.pending = undefined;
			let target: HTMLElement | null = null;
			if (destination.scroll) window.scrollTo(destination.scroll.x, destination.scroll.y);
			else if (destination.hash) {
				try {
					target = document.getElementById(decodeURIComponent(destination.hash.slice(1)));
				} catch {
					/* Invalid fragment. */
				}
				target?.scrollIntoView();
			}
			if (document.activeElement === document.body)
				(target ?? viewer.documentStageElement)?.focus({ preventScroll: true });
		});
	}
}

export function setDocumentNavigation() {
	const navigation = setContext(key, new DocumentNavigation());
	beforeNavigate(() => navigation.cancel());
	onNavigate(({ to }) => {
		if (
			!to ||
			!['admin', 'saved'].includes(describeRoute(to.route.id).document ?? '') ||
			navigation.isPreserved(to.url.href) ||
			to.url.searchParams.get('review') === '1'
		)
			return;
		// SvelteKit changes to.scroll to the applied (possibly clamped) value after commit.
		const destination: Destination = {
			href: to.url.href,
			scroll: to.scroll ? { ...to.scroll } : to.url.hash ? null : { x: 0, y: 0 },
			hash: to.url.hash
		};
		return () => {
			navigation.pending = destination;
		};
	});
	afterNavigate(({ type, to }) => {
		if (
			type === 'enter' &&
			to &&
			['admin', 'saved'].includes(describeRoute(to.route.id).document ?? '') &&
			to.url.hash &&
			to.url.searchParams.get('review') !== '1'
		)
			navigation.pending = { href: to.url.href, scroll: null, hash: to.url.hash };
	});
	onMount(() => {
		const abort = new AbortController();
		for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
			window.addEventListener(event, () => navigation.cancel(), {
				passive: true,
				signal: abort.signal
			});
		return () => abort.abort();
	});
	return navigation;
}
export function getDocumentNavigation(): DocumentNavigation | undefined {
	return getContext(key);
}

export function restoreDocumentNavigation(viewer: ContractViewerState) {
	const navigation = getDocumentNavigation();
	$effect(() => {
		void navigation?.pending;
		if (viewer.visible && viewer.prepared) untrack(() => navigation?.visible(viewer));
	});
}
