import { afterNavigate, beforeNavigate, disableScrollHandling, onNavigate } from '$app/navigation';
import { page } from '$app/state';
import { describeRoute } from '$lib/auth/routes';
import { revealInDocumentViewport } from '$lib/document/document-viewport';
import { getContext, onMount, setContext, tick, untrack } from 'svelte';
import type { DocumentSectionHandle } from './section.svelte';
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

interface ForegroundDocument {
	readonly identity: object;
	readonly currentIdentity: () => object;
	readonly viewer: DocumentViewerState;
	readonly section: DocumentSectionHandle;
	readonly active: () => boolean;
	readonly placed: () => boolean;
}

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
	current = $state.raw<ForegroundDocument>();
	#preserve = new Set<string>();
	capture(): DocumentScrollSnapshot {
		const surface = this.current;
		const viewport = surface?.section.viewport;
		return surface &&
			viewport &&
			isDocumentRoute(page.route.id) &&
			surface.identity === surface.currentIdentity() &&
			surface.active() &&
			surface.section.active &&
			viewport.isConnected
			? { href: page.url.href, scroll: { x: viewport.scrollLeft, y: viewport.scrollTop } }
			: null;
	}
	restore(snapshot: DocumentScrollSnapshot) {
		if (snapshot?.href === page.url.href && isDocumentRoute(page.route.id))
			this.open({ href: snapshot.href, kind: 'restore', scroll: snapshot.scroll });
	}
	claim(surface: ForegroundDocument) {
		this.current = surface;
		return () => {
			if (untrack(() => this.current) === surface) this.current = undefined;
		};
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
	#ready(surface: ForegroundDocument) {
		const viewport = surface.section.viewport;
		const stage = surface.viewer.documentStageElement;
		return Boolean(
			this.current === surface &&
			surface.identity === surface.currentIdentity() &&
			surface.active() &&
			surface.section.active &&
			surface.placed() &&
			surface.viewer.pagesVisible &&
			surface.viewer.layoutPrepared &&
			viewport?.isConnected &&
			stage &&
			viewport.contains(stage)
		);
	}
	visible(surface: ForegroundDocument, destination: DocumentNavigationIntent) {
		if (this.pending !== destination || page.url.href !== destination.href || !this.#ready(surface))
			return;
		void tick().then(() => {
			if (
				this.pending !== destination ||
				page.url.href !== destination.href ||
				!this.#ready(surface)
			)
				return;
			const scroller = surface.section.viewport!;
			const stage = surface.viewer.documentStageElement!;
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
				(target ?? stage).focus({ preventScroll: true });
		});
	}
}

export function setDocumentNavigation() {
	const navigation = setContext(key, new DocumentNavigation());
	$effect(() => {
		const destination = navigation.pending;
		const surface = navigation.current;
		if (!destination || !surface || page.url.href !== destination.href) return;
		if (
			surface.identity === surface.currentIdentity() &&
			surface.active() &&
			surface.section.active &&
			surface.placed() &&
			surface.viewer.pagesVisible &&
			surface.viewer.layoutPrepared &&
			surface.section.viewport &&
			surface.viewer.documentStageElement
		)
			untrack(() => navigation.visible(surface, destination));
	});
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

export function bindDocumentNavigation(
	viewer: DocumentViewerState,
	identity: () => object,
	section: () => DocumentSectionHandle | undefined,
	active: () => boolean,
	placed: () => boolean
) {
	const navigation = getDocumentNavigation();
	$effect(() => {
		const owner = section();
		const token = identity();
		if (!navigation || !owner || !active() || !owner.active) return;
		return untrack(() =>
			navigation.claim({
				identity: token,
				currentIdentity: identity,
				viewer,
				section: owner,
				active,
				placed
			})
		);
	});
}
