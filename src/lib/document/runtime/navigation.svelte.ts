import { afterNavigate, beforeNavigate, disableScrollHandling, onNavigate } from '$app/navigation';
import { page } from '$app/state';
import { describeRoute } from '$lib/auth/routes';
import {
	getDocumentViewportMetrics,
	revealInDocumentViewport
} from '$lib/document/document-viewport';
import { getContext, onMount, setContext, tick, untrack } from 'svelte';
import type { DocumentViewerState } from './viewer.svelte';

const key = Symbol('document-navigation');
type ScrollPosition = { x: number; y: number };
export type DocumentScrollSnapshot = { href: string; scroll: ScrollPosition } | null;

type DocumentNavigationIntent =
	| {
			href: string;
			kind: 'fresh';
			vertical: { kind: 'top' } | { kind: 'hash'; hash: string } | null;
	  }
	| { href: string; kind: 'restore'; scroll: ScrollPosition }
	| { href: string; kind: 'preserve' };

function isDocumentRoute(routeId: string | null) {
	const route = describeRoute(routeId);
	return Boolean(route.document || route.presentation === 'buyer-document');
}

function freshDestination(url: URL): DocumentNavigationIntent {
	return {
		href: url.href,
		kind: 'fresh',
		vertical:
			url.searchParams.get('review') === '1'
				? null
				: url.hash
					? { kind: 'hash', hash: url.hash }
					: { kind: 'top' }
	};
}

/** Replay the router's intended scroll position once deferred document DOM exists. */
class DocumentNavigation {
	pending = $state.raw<DocumentNavigationIntent>();
	placementRevision = $state(0);
	#preserve = new Set<string>();
	#viewports = new Set<HTMLElement>();
	#isVisibleViewport(viewport: HTMLElement) {
		return (
			viewport.isConnected &&
			viewport.clientWidth > 0 &&
			viewport.clientHeight > 0 &&
			viewport.getClientRects().length > 0 &&
			getComputedStyle(viewport).visibility === 'visible'
		);
	}
	#visibleViewport() {
		return [...this.#viewports].reverse().find((viewport) => this.#isVisibleViewport(viewport));
	}
	capture(): DocumentScrollSnapshot {
		const viewport = this.#visibleViewport();
		return viewport && isDocumentRoute(page.route.id)
			? { href: page.url.href, scroll: { x: viewport.scrollLeft, y: viewport.scrollTop } }
			: null;
	}
	restore(snapshot: DocumentScrollSnapshot) {
		if (snapshot?.href === page.url.href && isDocumentRoute(page.route.id))
			this.open({ href: snapshot.href, kind: 'restore', scroll: snapshot.scroll });
	}
	registerViewport(viewport: HTMLElement) {
		this.#viewports.add(viewport);
		this.placementChanged();
		return () => {
			this.#viewports.delete(viewport);
			this.placementChanged();
		};
	}
	placementChanged() {
		this.placementRevision++;
	}

	preserve(href: string) {
		this.#preserve.add(href);
		return () => this.#preserve.delete(href);
	}
	isPreserved(href: string) {
		return this.#preserve.has(href);
	}
	open(destination: DocumentNavigationIntent) {
		this.pending = destination.kind === 'preserve' ? undefined : destination;
	}
	cancel() {
		this.pending = undefined;
	}
	visible(viewer: DocumentViewerState, active: () => boolean) {
		const destination = this.pending;
		if (
			!destination ||
			page.url.href !== destination.href ||
			!active() ||
			!viewer.pagesVisible ||
			!viewer.layoutPrepared
		)
			return;
		void tick().then(() => {
			if (
				this.pending !== destination ||
				page.url.href !== destination.href ||
				!active() ||
				!viewer.pagesVisible ||
				!viewer.layoutPrepared
			)
				return;
			const scroller = getDocumentViewportMetrics(viewer.documentStageElement).scroller;
			if (!scroller || !this.#viewports.has(scroller) || !this.#isVisibleViewport(scroller)) return;
			this.pending = undefined;
			let target: HTMLElement | null = null;
			if (destination.kind === 'restore') {
				scroller.scrollTo(destination.scroll.x, destination.scroll.y);
			} else if (destination.kind === 'fresh') {
				scroller.scrollLeft = 0;
				if (destination.vertical?.kind === 'hash') {
					try {
						target = document.getElementById(
							decodeURIComponent(destination.vertical.hash.slice(1))
						);
					} catch {
						/* Invalid fragment. */
					}
					if (target && scroller.contains(target))
						revealInDocumentViewport(target, { block: 'start', inline: 'none' });
					else target = null;
				}
				if (destination.vertical?.kind === 'top') scroller.scrollTop = 0;
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
		if (!to || !isDocumentRoute(to.route.id)) return;
		disableScrollHandling();
		const destination: DocumentNavigationIntent = navigation.isPreserved(to.url.href)
			? { href: to.url.href, kind: 'preserve' }
			: freshDestination(to.url);
		return () => {
			if (destination.kind !== 'preserve') window.scrollTo(0, 0);
			navigation.open(destination);
		};
	});
	afterNavigate(({ type, to }) => {
		if (type !== 'enter' || !to || !isDocumentRoute(to.route.id)) return;
		window.scrollTo(0, 0);
		navigation.open(freshDestination(to.url));
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

export function restoreDocumentNavigation(viewer: DocumentViewerState, active: () => boolean) {
	const navigation = getDocumentNavigation();
	$effect(() => {
		void navigation?.pending;
		void navigation?.placementRevision;
		void viewer.documentStageElement;
		if (active() && viewer.pagesVisible && viewer.layoutPrepared)
			untrack(() => navigation?.visible(viewer, active));
	});
}
