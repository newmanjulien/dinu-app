<script lang="ts">
	import { onMount, onDestroy, tick, untrack } from 'svelte';
	import ChatCenteredTextIcon from 'phosphor-svelte/lib/ChatCenteredTextIcon';
	import EraserIcon from 'phosphor-svelte/lib/EraserIcon';
	import type { DiscussionSession } from './session.svelte';
	import type { DiscussionAnchor } from './validators';
	import { setDiscussionHighlights, clearDiscussionHighlights } from './highlights';
	import { captureDiscussionAnchor, discussionDomRange, indexDiscussionDom } from './dom-anchor';
	import { packAnnotationRail } from './annotation-rail-layout';
	import DiscussionThread from './DiscussionThread.svelte';
	import MessageComposer from './MessageComposer.svelte';
	let {
		session,
		documentRoot,
		layout,
		renderRevision,
		domRevision,
		active = true,
		obscured = false,
		onActivate
	}: {
		session: DiscussionSession;
		documentRoot?: HTMLElement | null;
		layout?: HTMLElement | null;
		renderRevision: unknown;
		domRevision: unknown;
		active?: boolean;
		obscured?: boolean;
		onActivate?: () => void;
	} = $props();
	let rail = $state<HTMLDivElement>(),
		positions = $state.raw<Record<string, number>>({}),
		anchors = $state.raw<Record<string, number>>({}),
		resolved = $state.raw<Set<string>>(new Set()),
		bottom = $state(0);
	let toolbar = $state.raw<{
		left: number;
		top: number;
		above: boolean;
		anchor: DiscussionAnchor;
	} | null>(null);
	let alive = true;
	const highlightOwner = Symbol('discussion-highlights');
	let ranges = new Map<string, Range>();
	let paperRight = $state(0),
		documentBottom = $state(0);
	let frame: number | undefined,
		selectionPointer: number | null = null;
	const cards = $derived([
		...session.threads.map((t) => ({ id: t.id, anchor: t.anchor, type: t.type })),
		...(session.composer
			? [{ id: 'composer', anchor: session.composer.anchor, type: session.composer.type }]
			: [])
	]);
	let domCache:
		| {
				root: HTMLElement;
				render: unknown;
				pages: unknown;
				index: ReturnType<typeof indexDiscussionDom>;
		  }
		| undefined;
	$effect(() => {
		void documentRoot;
		void renderRevision;
		void domRevision;
		void active;
		domCache = undefined;
		ranges.clear();
		untrack(() => clearDiscussionHighlights(highlightOwner));
	});
	function index() {
		if (!documentRoot) return;
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
		return domCache.index;
	}

	function schedule() {
		if (!alive || frame !== undefined) return;
		frame = requestAnimationFrame(() => {
			frame = undefined;
			measure();
		});
	}
	function measure() {
		if (!alive || !active || !layout?.isConnected || !documentRoot?.isConnected) {
			clearDiscussionHighlights(highlightOwner);
			return;
		}
		const base = layout.getBoundingClientRect(),
			next: Record<string, number> = {},
			found = new Set<string>();
		paperRight = documentRoot.getBoundingClientRect().right - base.left;
		documentBottom = base.height;
		ranges = new Map();
		const highlights = {
			comment: [] as Range[],
			proposal: [] as Range[],
			activeComment: [] as Range[],
			activeProposal: [] as Range[]
		};
		const domIndex = index()!;
		const items = cards.map((card, order) => {
			const range = discussionDomRange(documentRoot!, card.anchor, domIndex),
				rect = range?.getClientRects()[0];
			if (rect && range) {
				ranges.set(card.id, range);
				const thread = card.id === 'composer' ? undefined : card;
				if (card.id === session.selected)
					highlights[card.type === 'proposal' ? 'activeProposal' : 'activeComment'].push(range);
				else if (thread)
					highlights[thread.type === 'proposal' ? 'proposal' : 'comment'].push(range);
				found.add(card.id);
				next[card.id] = Math.max(0, rect.top - base.top);
			}
			const node = rail?.querySelector<HTMLElement>(
				`[data-discussion-card="${CSS.escape(card.id)}"]`
			);
			return {
				id: card.id,
				anchorTop: next[card.id] ?? anchors[card.id] ?? order * 90,
				height: node?.getBoundingClientRect().height ?? 100,
				order
			};
		});
		const packed = packAnnotationRail(
			items,
			session.selected && next[session.selected] !== undefined
				? { id: session.selected, targetTop: next[session.selected] }
				: null
		);
		setDiscussionHighlights(highlightOwner, highlights);
		anchors = next;
		resolved = found;
		positions = packed.placements;
		bottom = packed.bottom;
	}
	$effect(() => {
		void renderRevision;
		void domRevision;
		void cards;
		void session.selected;
		void active;
		if (!active) untrack(() => clearDiscussionHighlights(highlightOwner));
		untrack(() => void tick().then(schedule));
	});
	function selectionChanged() {
		if (selectionPointer !== null) return;
		const selection = window.getSelection();
		if (
			!active ||
			!session.active ||
			!selection ||
			selection.isCollapsed ||
			!selection.rangeCount ||
			!documentRoot
		) {
			toolbar = null;
			return;
		}
		const range = selection.getRangeAt(0),
			anchor =
				documentRoot.contains(range.startContainer) && documentRoot.contains(range.endContainer)
					? captureDiscussionAnchor(documentRoot, range, index()!.entries)
					: null;
		if (!anchor) {
			toolbar = null;
			return;
		}
		const rects = [...range.getClientRects()].filter((r) => r.width && r.height),
			first = rects[0],
			last = rects.at(-1);
		if (!first || !last) {
			toolbar = null;
			return;
		}
		const below = last.bottom + 49 < window.innerHeight;
		toolbar = {
			anchor,
			left: Math.min(window.innerWidth - 40, Math.max(40, last.left + last.width / 2)),
			top: below ? last.bottom + 10 : first.top - 10,
			above: !below
		};
	}
	function begin(type: 'comment' | 'proposal') {
		if (!toolbar) return;
		onActivate?.();
		session.begin(toolbar.anchor, type);
		toolbar = null;
		window.getSelection()?.removeAllRanges();
	}
	function activate(id: string) {
		onActivate?.();
		session.selected = id;
		void session.loadBuyerViewer();
	}
	onMount(() => {
		let selectionFrame: number | undefined;
		const updateSelection = () => {
			if (selectionFrame === undefined)
				selectionFrame = requestAnimationFrame(() => {
					selectionFrame = undefined;
					selectionChanged();
				});
		};
		const pointerDown = (event: PointerEvent) => {
			if (event.isPrimary && event.button === 0 && documentRoot?.contains(event.target as Node)) {
				selectionPointer = event.pointerId;
				toolbar = null;
			}
		};
		const pointerUp = (event: PointerEvent) => {
			if (event.pointerId === selectionPointer) {
				selectionPointer = null;
				updateSelection();
			}
		};
		const blur = () => {
			selectionPointer = null;
			toolbar = null;
		};
		const resize = () => {
			schedule();
			updateSelection();
		};
		const openAtPoint = (event: MouseEvent) => {
			if (!active || !window.getSelection()?.isCollapsed) return;
			const found = [...ranges].find(
				([id, range]) =>
					id !== 'composer' &&
					[...range.getClientRects()].some(
						(rect) =>
							event.clientX >= rect.left &&
							event.clientX <= rect.right &&
							event.clientY >= rect.top &&
							event.clientY <= rect.bottom
					)
			);
			if (found) {
				event.stopPropagation();
				activate(found[0]);
			}
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && toolbar) {
				toolbar = null;
				window.getSelection()?.removeAllRanges();
			}
		};
		documentRoot?.addEventListener('click', openAtPoint, true);
		document.addEventListener('keydown', escape);
		const observer = new ResizeObserver(schedule);
		if (rail) observer.observe(rail);
		if (layout) observer.observe(layout);
		document.addEventListener('selectionchange', updateSelection);
		document.addEventListener('pointerdown', pointerDown);
		window.addEventListener('pointerup', pointerUp);
		window.addEventListener('pointercancel', pointerUp);
		window.addEventListener('blur', blur);
		window.addEventListener('resize', resize);
		window.addEventListener('scroll', updateSelection, true);
		schedule();
		return () => {
			observer.disconnect();
			documentRoot?.removeEventListener('click', openAtPoint, true);
			document.removeEventListener('keydown', escape);
			document.removeEventListener('selectionchange', updateSelection);
			document.removeEventListener('pointerdown', pointerDown);
			window.removeEventListener('pointerup', pointerUp);
			window.removeEventListener('pointercancel', pointerUp);
			window.removeEventListener('blur', blur);
			window.removeEventListener('resize', resize);
			window.removeEventListener('scroll', updateSelection, true);
			if (selectionFrame !== undefined) cancelAnimationFrame(selectionFrame);
		};
	});
	function observeCard(node: HTMLElement) {
		const observer = new ResizeObserver(schedule);
		observer.observe(node);
		schedule();
		return { destroy: () => observer.disconnect() };
	}
	onDestroy(() => {
		alive = false;
		domCache = undefined;
		ranges.clear();
		clearDiscussionHighlights(highlightOwner);
		if (frame !== undefined) cancelAnimationFrame(frame);
	});
</script>

{#if active}
	{#if toolbar}<div
			class={[
				'fixed z-50 flex h-[31px] w-[58px] -translate-x-1/2 items-center justify-center rounded-[5px] border border-line bg-surface shadow-floating',
				toolbar.above && '-translate-y-full'
			]}
			style:left={`${toolbar.left}px`}
			style:top={`${toolbar.top}px`}
			role="group"
			aria-label="Text selection actions"
			data-document-control
		>
			<button
				type="button"
				aria-label="Add comment"
				title="Add comment"
				class="flex size-7 cursor-pointer items-center justify-center rounded-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-accent"
				onpointerdown={(event) => event.preventDefault()}
				onclick={() => begin('comment')}><ChatCenteredTextIcon size={20} /></button
			>
			<button
				type="button"
				aria-label="Propose change"
				title="Propose change"
				class="flex size-7 cursor-pointer items-center justify-center rounded-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-accent"
				onpointerdown={(event) => event.preventDefault()}
				onclick={() => begin('proposal')}><EraserIcon size={20} /></button
			>
		</div>{/if}
	{#if session.threads.length || session.error}
		<div
			class="pointer-events-auto absolute inset-x-3 z-10 flex items-center justify-end gap-3 text-xs text-ink-muted @min-[1150px]:hidden"
			style:top={`${documentBottom + 8}px`}
		>
			{#if session.threads.length}<button
					type="button"
					class="cursor-pointer underline"
					onclick={() => activate(session.threads[0].id)}>View discussions</button
				>{/if}
			{#if !session.done}<button
					type="button"
					class="cursor-pointer underline"
					disabled={session.loading}
					onclick={() => session.loadMore()}
					>{session.loading ? 'Loading…' : 'More discussions'}</button
				>{/if}
			{#if session.error}<button
					type="button"
					class="cursor-pointer underline"
					onclick={() => session.retry()}>Retry discussions</button
				>{/if}
		</div>
	{/if}
	<div class="pointer-events-none absolute inset-0 z-10" aria-label="Discussion markers">
		{#each session.threads as thread (thread.id)}{#if resolved.has(thread.id)}<button
					type="button"
					class="pointer-events-auto absolute flex size-6 cursor-pointer items-center justify-center rounded-full border border-line bg-surface text-ink-secondary focus-visible:outline-2 focus-visible:outline-accent"
					style:left={`${paperRight - 24}px`}
					style:top={`${anchors[thread.id]}px`}
					aria-label={`Open ${thread.type === 'proposal' ? 'proposed change' : 'comment'}: ${thread.anchor.quote.slice(0, 80)}`}
					onclick={() => activate(thread.id)}><ChatCenteredTextIcon size={14} /></button
				>{/if}{/each}
	</div>
{/if}
<div
	bind:this={rail}
	class="pointer-events-none absolute top-0 left-[calc(var(--page-left)+var(--page-width)+var(--panel-gap))] z-20 w-(--panel-width) @max-[1150px]:fixed @max-[1150px]:inset-x-0 @max-[1150px]:top-auto @max-[1150px]:bottom-[var(--buyer-link-bar-height,0px)] @max-[1150px]:z-30 @max-[1150px]:w-auto @max-[1150px]:h-auto!"
	style:height={`${bottom}px`}
	class:hidden={!active || obscured}
	aria-label="Contract discussions"
>
	{#each session.threads as thread (thread.id)}
		<div
			use:observeCard
			data-discussion-card={thread.id}
			class={[
				'pointer-events-auto absolute inset-x-0 top-0 @min-[1150px]:translate-y-(--discussion-top) @max-[1150px]:static @max-[1150px]:max-h-[65dvh] @max-[1150px]:overflow-y-auto',
				session.selected !== thread.id && '@max-[1150px]:hidden'
			]}
			style:--discussion-top={`${positions[thread.id] ?? 0}px`}
		>
			{#if session.selected === thread.id}
				{@const index = session.threads.findIndex((t) => t.id === thread.id)}
				<div
					class="flex items-center justify-end gap-3 rounded-t-[9px] bg-surface px-3 py-1 text-xs text-ink-muted @min-[1150px]:hidden"
				>
					<button
						type="button"
						class="cursor-pointer underline disabled:opacity-50"
						disabled={index === 0}
						onclick={() => activate(session.threads[index - 1].id)}>Previous</button
					>
					<button
						type="button"
						class="cursor-pointer underline disabled:opacity-50"
						disabled={index === session.threads.length - 1}
						onclick={() => activate(session.threads[index + 1].id)}>Next</button
					>
					<button type="button" class="cursor-pointer" onclick={() => (session.selected = null)}
						>Close</button
					>
				</div>
			{/if}
			<DiscussionThread {thread} {session} orphaned={!resolved.has(thread.id)} />
		</div>
	{/each}
	{#if session.composer}
		<div
			use:observeCard
			data-discussion-card="composer"
			class="pointer-events-auto absolute inset-x-0 top-0 @min-[1150px]:translate-y-(--discussion-top) rounded-[9px] border border-line bg-surface p-3.5 @max-[1150px]:static @max-[1150px]:max-h-[65dvh] @max-[1150px]:overflow-y-auto"
			style:--discussion-top={`${positions.composer ?? 0}px`}
		>
			<MessageComposer
				text={session.text}
				author={session.viewer}
				viewerKey={session.viewer?.key}
				title={session.composer.type === 'proposal' ? 'Propose change' : 'Add comment'}
				placeholder={session.composer.type === 'proposal'
					? 'Write the proposed wording or change…'
					: 'Write a comment…'}
				submitLabel={session.composer.type === 'proposal' ? 'Propose change' : 'Comment'}
				cancelLabel="Cancel"
				submitOnEnter
				pending={session.submitting}
				errorMessage={session.composeError ?? session.error ?? ''}
				onTextChange={(text) => (session.text = text)}
				onCancel={() => session.cancel()}
				onSubmit={() => void session.submit()}
			/>
		</div>
	{/if}
	{#if session.authRequired}<div
			class="pointer-events-auto relative z-30 rounded-lg border border-line bg-surface p-3 text-xs"
		>
			<p>Your draft is still here. Reconnect your account, then retry.</p>
			<a href="/login" target="_blank" rel="noopener noreferrer" class="mt-2 inline-block underline"
				>Sign in in another tab</a
			><button type="button" class="ml-3 underline" onclick={() => session.loadBuyerViewer()}
				>Retry account</button
			><button
				type="button"
				disabled={!session.canContinueAsBuyer}
				class="mt-2 block underline disabled:opacity-50"
				onclick={() => session.continueAsBuyer()}>Continue as Buyer</button
			>
			<p class="mt-2 text-ink-muted">
				Continue as Buyer changes the author for new messages. Pending account submissions and
				account-owned edits still need that account.
			</p>
		</div>{/if}
	{#if !session.done || session.error}<div
			class="pointer-events-auto absolute inset-x-0 rounded-[9px] bg-surface p-3 text-xs text-ink-muted @max-[1150px]:hidden"
			style:top={`${bottom + 8}px`}
		>
			{#if session.error}<p role="alert">{session.error}</p>
				<button
					class="cursor-pointer underline"
					onclick={() => {
						session.setActive(false);
						session.setActive(true);
					}}>Retry</button
				>
			{:else}<button
					class="cursor-pointer underline"
					disabled={session.loading}
					onclick={() => session.loadMore()}
					>{session.loading ? 'Loading discussions…' : 'More discussions'}</button
				>{/if}
		</div>{/if}
</div>

<style>
	:global(::highlight(dinu-discussion-comment)) {
		background: #d2e3fc;
		color: inherit;
	}
	:global(::highlight(dinu-discussion-proposal)) {
		background: rgba(95, 99, 104, 0.1);
		color: var(--color-ink-muted);
		text-decoration: line-through;
	}
	:global(::highlight(dinu-discussion-active-comment)) {
		background: #b7d0fa;
		color: inherit;
	}
	:global(::highlight(dinu-discussion-active-proposal)) {
		background: rgba(95, 99, 104, 0.18);
		color: var(--color-ink-muted);
		text-decoration: line-through;
	}
</style>
