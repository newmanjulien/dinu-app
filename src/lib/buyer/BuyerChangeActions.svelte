<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { discussionDomRange, indexDiscussionDom } from '$lib/discussions/dom-anchor';
	import type { DiscussionSession, DiscussionThread } from '$lib/discussions/session.svelte';
	import type { DocumentHighlightController } from '$lib/document/highlights/controller';
	import type { BuyerChangeReview } from './reviews.svelte';
	let {
		review,
		session,
		root,
		layout,
		highlights,
		renderRevision,
		domRevision,
		ready
	}: {
		review: BuyerChangeReview;
		session: DiscussionSession;
		root: HTMLElement | null;
		layout: HTMLElement | null;
		highlights?: DocumentHighlightController;
		renderRevision: unknown;
		domRevision: unknown;
		ready: boolean;
	} = $props();
	let active = $state<string | null>(null);
	let geometries = $state.raw<
		{ id: DiscussionThread['id']; rects: DOMRect[]; left: number; top: number }[]
	>([]);
	const threads = $derived(
		session.threads.filter(
			(thread) => thread.type === 'proposal' && session.feed.authorized && !thread.root.deleted
		)
	);
	let retry = $state(0);
	$effect(() => {
		void retry;
		const thread = ready ? threads.find((thread) => thread.id === active) : undefined;
		if (thread) return review.watchProposal(thread);
	});
	const passages = $derived.by(() => {
		if (!ready) return [];
		const current = new Map(threads.map((thread) => [thread.id, thread]));
		return geometries.flatMap((geometry) => {
			const thread = current.get(geometry.id);
			return thread ? [{ ...geometry, thread }] : [];
		});
	});
	let overlay: HTMLDivElement;
	let domCache:
		| {
				root: HTMLElement;
				render: unknown;
				pages: unknown;
				index: ReturnType<typeof indexDiscussionDom>;
		  }
		| undefined;
	onDestroy(() => {
		domCache = undefined;
	});
	function measure() {
		const documentRoot = root;
		const container = layout;
		if (!ready || !documentRoot?.isConnected || !container?.isConnected) {
			domCache = undefined;
			geometries = [];
			return;
		}
		if (!threads.length) {
			geometries = [];
			return;
		}
		if (
			!domCache ||
			domCache.root !== documentRoot ||
			domCache.render !== renderRevision ||
			domCache.pages !== domRevision
		)
			domCache = {
				root: documentRoot,
				render: renderRevision,
				pages: domRevision,
				index: indexDiscussionDom(documentRoot)
			};
		const index = domCache.index,
			origin = container.getBoundingClientRect();
		geometries = threads.flatMap((thread) => {
			const range = discussionDomRange(documentRoot, thread.anchor, index);
			const rects = range
				? [...range.getClientRects()]
						.filter((r) => r.height && r.width)
						.map((r) => new DOMRect(r.x - origin.left, r.y - origin.top, r.width || 8, r.height))
				: [];
			const first = rects[0];
			return first
				? [{ id: thread.id, rects, left: first.left + first.width / 2, top: first.top }]
				: [];
		});
	}
	$effect(() => {
		void root;
		void layout;
		void renderRevision;
		void domRevision;
		if (!ready) domCache = undefined;
		void threads;
		let cancelled = false;
		void tick().then(() => {
			if (!cancelled) untrack(measure);
		});
		return () => {
			cancelled = true;
		};
	});
	$effect(() => highlights?.subscribeGeometry(measure));
	$effect(() => {
		if (!ready || !threads.some((t) => t.id === active)) active = null;
	});
	$effect(() => {
		const host = root;
		const container = layout;
		if (!host || !container) return;
		const position = (event: MouseEvent) => {
			const rect = container.getBoundingClientRect();
			return { x: event.clientX - rect.left, y: event.clientY - rect.top };
		};
		const hit = (point: { x: number; y: number }) =>
			passages.find((g) =>
				g.rects.some(
					(r) => point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom
				)
			);
		const move = (event: PointerEvent) => {
			if (!ready || event.pointerType === 'touch' || overlay?.contains(event.target as Node))
				return;
			const point = position(event),
				geometry = hit(point);
			if (geometry) active = geometry.id;
			else if (!overlay?.contains(document.activeElement)) {
				const current = passages.find((g) => g.id === active),
					first = current?.rects[0];
				if (
					!first ||
					point.y < first.top - 40 ||
					point.y > first.bottom + 4 ||
					Math.abs(point.x - (first.left + first.width / 2)) > Math.max(80, first.width / 2)
				)
					active = null;
			}
		};
		const tap = (event: PointerEvent) => {
			if (!ready || event.pointerType === 'mouse') return;
			const point = position(event),
				geometry = hit(point);
			if (geometry) {
				active = geometry.id;
				event.stopPropagation();
			}
		};
		const leave = () => {
			if (!overlay?.matches(':hover') && !overlay?.contains(document.activeElement)) active = null;
		};
		host.addEventListener('pointermove', move);
		host.addEventListener('pointerdown', tap, true);
		const click = (event: MouseEvent) => {
			if (event instanceof PointerEvent && event.pointerType !== 'mouse' && hit(position(event))) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		};
		host.addEventListener('click', click, true);
		container.addEventListener('pointerleave', leave);
		window.addEventListener('resize', measure);
		return () => {
			host.removeEventListener('click', click, true);
			host.removeEventListener('pointermove', move);
			host.removeEventListener('pointerdown', tap, true);
			container.removeEventListener('pointerleave', leave);
			window.removeEventListener('resize', measure);
		};
	});
</script>

<div
	bind:this={overlay}
	class="pointer-events-none absolute inset-0 z-30"
	aria-label="Buyer change actions"
>
	{#each passages as geometry (geometry.id)}
		{@const thread = geometry.thread}
		{@const support = review.supportFor(thread)}
		{@const sourceMatches =
			support?.currentRootMessageId === thread.root.id &&
			support.currentRootRevision === thread.root.revision}
		{@const pending = Boolean(
			sourceMatches &&
			support?.currentChangeId &&
			support.currentChangeId !== support.appliedChangeId
		)}
		{@const applied = Boolean(
			sourceMatches &&
			support?.currentChangeId &&
			support.currentChangeId === support.appliedChangeId
		)}
		{@const label = pending
			? 'Withdraw pending change'
			: review.seller.viewer?.role === 'admin'
				? 'Apply change'
				: 'Support proposal'}
		{#if !applied}
			<div
				class="absolute -translate-x-1/2 -translate-y-full pb-1"
				style:left={`${geometry.left}px`}
				style:top={`${geometry.top}px`}
			>
				<button
					type="button"
					class={[
						'rounded-md bg-ink px-3 py-1.5 text-xs whitespace-nowrap text-white shadow-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
						active === geometry.id
							? 'pointer-events-auto opacity-100'
							: 'pointer-events-none opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100'
					]}
					disabled={!ready || review.busy || !review.coherent || !support}
					aria-label={`${support ? label : 'Checking proposal…'}: ${thread.anchor.quote}`}
					onfocus={() => (active = geometry.id)}
					onpointerenter={() => (active = geometry.id)}
					onclick={(event) => {
						event.stopPropagation();
						void review.accept(thread);
					}}>{support ? label : 'Checking proposal…'}</button
				>
				{#if review.passageError?.threadId === geometry.id}<p
						role="alert"
						class="pointer-events-auto mt-1 max-w-72 rounded-md bg-surface p-2 text-xs text-danger shadow-control"
					>
						{review.passageError.message}
						<button class="underline" onclick={() => retry++}>Try again</button>
					</p>{/if}
			</div>
		{/if}
	{/each}
</div>
