<script lang="ts">
	import { onMount, onDestroy, tick, untrack } from 'svelte';
	import type { DiscussionSession } from './session.svelte';
	import type { DiscussionAnchor } from './validators';
	import type { DocumentHighlightController } from '$lib/document/highlights/controller';
	import DocumentPanelRail from '$lib/components/document/DocumentPanelRail.svelte';
	import DocumentPanelCard from '$lib/components/document/DocumentPanelCard.svelte';
	import DocumentPanelBody from '$lib/components/document/DocumentPanelBody.svelte';
	import Hint from '$lib/ui/Hint.svelte';
	import { LOGIN_PATH } from '$lib/auth/navigation';
	import InlineAction from '$lib/components/playbook/InlineAction.svelte';
	import { captureDiscussionAnchor, discussionDomRange, indexDiscussionDom } from './dom-anchor';
	import { packAnnotationRail } from './annotation-rail-layout';
	import DiscussionRootCard from './DiscussionRootCard.svelte';
	import DiscussionThread from './DiscussionThread.svelte';
	import MessageComposer from './MessageComposer.svelte';
	import { composerBoundary } from './focus-composer';
	import SelectionToolbar from '$lib/components/document/SelectionToolbar.svelte';
	import BoxDismissal from '$lib/components/playbook/BoxDismissal.svelte';
	import { setInteractionOwner, type CloseReason } from '$lib/components/ui/interactions';
	import type { FloatingVirtualAnchor } from '$lib/components/ui/floating';
	const interactionOwner = setInteractionOwner(Symbol('discussions'));
	let openingTrigger: HTMLElement | undefined;
	function rememberTrigger() {
		const focused = document.activeElement;
		if (focused instanceof HTMLElement && !rail?.contains(focused)) openingTrigger = focused;
		if (!openingTrigger || openingTrigger === document.body)
			openingTrigger = documentRoot ?? undefined;
	}
	function dismissPanel(restore: boolean) {
		if (session.selected === 'composer') {
			collapseComposer(restore);
		} else {
			session.selected = null;
			if (restore && openingTrigger?.isConnected) openingTrigger.focus({ preventScroll: true });
		}
	}
	function collapseComposer(restoreFocus = false) {
		session.collapseCreate();
		if (restoreFocus && openingTrigger?.isConnected) openingTrigger.focus({ preventScroll: true });
	}

	let {
		session,
		highlights,
		documentRoot,
		layout,
		renderRevision,
		domRevision,
		active = true,
		obscured = false,
		onActivate
	}: {
		session: DiscussionSession;
		highlights?: DocumentHighlightController;
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
		positioned = $state.raw<Set<string>>(new Set()),
		resolved = $state.raw<Set<string>>(new Set()),
		bottom = $state(0);
	let toolbar = $state.raw<{
		reference: FloatingVirtualAnchor;
		anchor: DiscussionAnchor;
	} | null>(null);
	$effect(() => {
		void session.policyVersion;
		toolbar = null;
		dismissedSelection = undefined;
		selectionPointer = null;
		window.getSelection()?.removeAllRanges();
	});
	const visibleComposerCard = $derived(session.composer);
	const previewEntry = $derived(
		active &&
			!obscured &&
			session.authorized &&
			session.policy().readOnly &&
			session.perspective() === 'buyer'
	);
	const showSellerNameHint = $derived(
		!session.readOnly && !session.authRequired && session.missingSellerName()
	);
	const selectionGeometryListeners = new Set<() => void>();
	let dismissedSelection: string | undefined;
	let alive = true;
	let ranges = $state.raw(new Map<string, Range>());
	let documentBottom = $state(0);
	let railOrder: string[] = [];
	let railOrderFrozen = false;
	let railOrderInputs:
		| {
				root: HTMLElement;
				layout: HTMLElement;
				highlights: DocumentHighlightController | undefined;
				render: unknown;
				width: number;
				cards: string;
		  }
		| undefined;
	let measuredAnchors = new Map<string, { signature: string; top: number }>();
	$effect(() => {
		if (!active || obscured) session.closeEditors();
	});
	let frame: number | undefined,
		selectionPointer: number | null = null;
	const threads = $derived(session.threads);
	const cards = $derived([
		...threads.map((thread) => ({
			key: thread.id,
			id: thread.id,
			anchor: thread.anchor,
			available: session.authorized
		})),
		...(visibleComposerCard
			? [
					{
						key: 'composer',
						id: 'composer',
						anchor: visibleComposerCard.anchor,
						available: visibleComposerCard.contentRevision === session.contentRevision()
					}
				]
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
		toolbar = null;
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

	$effect(() => {
		void renderRevision;
		void domRevision;
		const root = documentRoot;
		const items = cards;
		ranges =
			active && root
				? new Map(
						items.flatMap((card) => {
							if (!card.available) return [];
							const range = discussionDomRange(root, card.anchor, index()!);
							return range ? [[card.id, range] as const] : [];
						})
					)
				: new Map();
	});
	function groupName(id: string) {
		return `discussion:${id}`;
	}
	$effect(() => {
		const controller = highlights;
		const element = rail;
		if (!controller || !element || !active) return;
		const groups = new Map<string, HTMLElement>();
		$effect(() => {
			const currentRanges = ranges;
			const selected = session.selected;
			const items = cards;
			untrack(() => {
				const desired = new Set<string>();
				const selectionChanged = new Set<string>();
				for (const card of items) {
					const range = currentRanges.get(card.id);
					const owner = element.querySelector<HTMLElement>(
						`[data-discussion-card="${CSS.escape(card.id)}"]`
					);
					if (!range || !owner) continue;
					const name = groupName(card.id);
					const previousOwner = groups.get(name);
					if (previousOwner && previousOwner !== owner) controller.clearGroup(name);
					const selectedFlag = String(card.id === selected);
					if (previousOwner === owner && owner.dataset.annotationSelected !== selectedFlag)
						selectionChanged.add(name);
					owner.dataset.annotationId = name;
					owner.dataset.annotationSelected = selectedFlag;
					owner.dataset.annotationPriority = '-1';
					owner.dataset.discussionId = card.id;
					controller.setGroup(
						name,
						card.id === 'composer' ? 'authoring-selection' : 'buyer-attachment',
						[range],
						undefined,
						owner
					);
					if (card.id === selected) controller.ensureRangeGeometry(range);
					groups.set(name, owner);
					desired.add(name);
				}
				for (const name of groups.keys()) {
					if (desired.has(name)) continue;
					controller.clearGroup(name);
					groups.delete(name);
				}
				if (selectionChanged.size) controller.annotationsChanged(selectionChanged);
				schedule();
			});
		});
		return () => {
			for (const name of groups.keys()) controller.clearGroup(name);
		};
	});
	$effect(() => highlights?.subscribeGeometry(() => schedule()));

	function schedule() {
		if (!alive || frame !== undefined) return;
		frame = requestAnimationFrame(() => {
			frame = undefined;
			measure();
			for (const update of selectionGeometryListeners) update();
		});
	}
	function measure() {
		if (!alive || !active || !layout?.isConnected || !documentRoot?.isConnected || !cards.length) {
			railOrder = [];
			railOrderFrozen = false;
			railOrderInputs = undefined;
			measuredAnchors.clear();
			resolved = new Set();
			positions = {};
			positioned = new Set();
			bottom = 0;
			documentBottom = active ? (layout?.getBoundingClientRect().height ?? 0) : 0;
			return;
		}
		const cardSignature = JSON.stringify(
			cards.map((card) => [card.key, card.id, card.anchor, card.available])
		);
		const documentWidth = documentRoot.getBoundingClientRect().width;
		const sameDocument =
			railOrderInputs?.root === documentRoot &&
			railOrderInputs.layout === layout &&
			railOrderInputs.highlights === highlights &&
			railOrderInputs.render === renderRevision &&
			railOrderInputs.width === documentWidth;
		if (!sameDocument) measuredAnchors.clear();
		const sameCards = sameDocument && railOrderInputs?.cards === cardSignature;
		if (!sameCards) {
			railOrder = [];
			railOrderFrozen = false;
		}
		const base = layout.getBoundingClientRect(),
			next: Record<string, number> = {},
			retainedAnchors = new Map<string, { signature: string; top: number }>();
		documentBottom = base.height;
		const items = cards.map((card, order) => {
			const signature = JSON.stringify([card.id, card.anchor, card.available]);
			const rect = card.available
				? highlights?.annotationAnchorRect(groupName(card.id))
				: undefined;
			const cached = measuredAnchors.get(card.key);
			const cachedTop = cached?.signature === signature ? cached.top : undefined;
			if (rect && (rect.width || rect.height)) next[card.key] = Math.max(0, rect.top - base.top);
			const exactTop = next[card.key] ?? cachedTop;
			if (exactTop !== undefined) retainedAnchors.set(card.key, { signature, top: exactTop });
			const anchorTop = exactTop ?? (rect ? Math.max(0, rect.top - base.top) : undefined);
			const node = rail?.querySelector<HTMLElement>(
				`[data-discussion-card="${CSS.escape(card.id)}"]`
			);
			return {
				id: card.key,
				anchorTop: anchorTop ?? order * 90,
				height: node?.getBoundingClientRect().height ?? 100,
				order
			};
		});
		const selectedKey = cards.find((card) => card.id === session.selected)?.key;
		const selectedTop = selectedKey ? retainedAnchors.get(selectedKey)?.top : undefined;
		const packed = packAnnotationRail(
			items,
			selectedKey && selectedTop !== undefined ? { id: selectedKey, targetTop: selectedTop } : null,
			sameCards && (railOrderFrozen || selectedTop !== undefined) ? railOrder : undefined
		);
		measuredAnchors = retainedAnchors;
		railOrder = packed.orderedIds;
		railOrderFrozen ||= selectedTop !== undefined;
		railOrderInputs = {
			root: documentRoot,
			layout,
			highlights,
			render: renderRevision,
			width: documentWidth,
			cards: cardSignature
		};
		resolved = new Set(ranges.keys());
		positioned = new Set(Object.keys(positions));
		positions = packed.placements;
		bottom = packed.bottom;
	}

	$effect(() => {
		void renderRevision;
		void domRevision;
		void documentRoot;
		void layout;
		void obscured;
		void cards;
		void session.selected;
		void active;
		if (!active) toolbar = null;
		untrack(() => void tick().then(schedule));
	});
	function selectionChanged() {
		if (selectionPointer !== null) return;
		const selection = window.getSelection();
		if (
			!active ||
			!session.active ||
			session.readOnly ||
			!selection ||
			selection.isCollapsed ||
			!selection.rangeCount ||
			!documentRoot
		) {
			dismissedSelection = undefined;
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
		if (JSON.stringify(anchor) === dismissedSelection) {
			toolbar = null;
			return;
		}
		dismissedSelection = undefined;
		const rects = [...range.getClientRects()].filter((r) => r.width && r.height),
			first = rects[0],
			last = rects.at(-1);
		if (!first || !last) {
			toolbar = null;
			return;
		}
		toolbar = {
			anchor,
			reference: {
				subscribe: (update) => {
					selectionGeometryListeners.add(update);
					return () => {
						selectionGeometryListeners.delete(update);
					};
				},
				contextElement: range.endContainer.parentElement ?? documentRoot,
				getBoundingClientRect: () => {
					const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
					return rects.at(-1) ?? new DOMRect();
				}
			}
		};
	}
	function dismissToolbar(reason: CloseReason) {
		dismissedSelection = toolbar ? JSON.stringify(toolbar.anchor) : undefined;
		toolbar = null;
		if (reason !== 'outside-pointer') window.getSelection()?.removeAllRanges();
	}
	function begin() {
		if (session.readOnly || !toolbar) return;
		rememberTrigger();
		onActivate?.();
		session.begin(toolbar.anchor);
		focusComposer();
		toolbar = null;
		window.getSelection()?.removeAllRanges();
	}
	function focusComposer() {
		const current = session.captureWriteAccess();
		void tick().then(() => {
			if (
				current() &&
				active &&
				!obscured &&
				session.selected === 'composer' &&
				session.composer &&
				!session.composer.busy
			)
				rail
					?.querySelector<HTMLTextAreaElement>('[data-discussion-card="composer"] textarea')
					?.focus({ preventScroll: true });
		});
	}
	$effect(() => {
		const selected = session.selected;
		const replyingTo = session.replyingTo;
		if (!selected || !active || obscured) return;
		const policyGeneration = untrack(() => session.policyVersion);
		void tick().then(() => {
			if (
				session.policyVersion !== policyGeneration ||
				session.selected !== selected ||
				session.replyingTo !== replyingTo
			)
				return;
			const panel = rail?.querySelector<HTMLElement>('[data-workspace-panel]');
			if (!panel || getComputedStyle(panel).overflowY !== 'auto') return;
			const card = rail?.querySelector<HTMLElement>(
				`[data-discussion-card="${CSS.escape(selected)}"]`
			);
			const target =
				(replyingTo === selected && card?.querySelector<HTMLElement>('[data-discussion-reply]')) ||
				card;
			if (!target) return;
			const bounds = target.getBoundingClientRect(),
				viewport = panel.getBoundingClientRect(),
				viewportTop = viewport.top + (panel.firstElementChild?.getBoundingClientRect().height ?? 0);
			if (bounds.top < viewportTop) panel.scrollTop += bounds.top - viewportTop;
			else if (bounds.bottom > viewport.bottom)
				panel.scrollTop +=
					target === card && bounds.height > viewport.bottom - viewportTop
						? bounds.top - viewportTop
						: bounds.bottom - viewport.bottom;
		});
	});
	export function activate(id: string, restoreToDocument = false) {
		if (session.readOnly && id === 'composer') return;
		rememberTrigger();
		if (restoreToDocument || !openingTrigger || openingTrigger === document.body)
			openingTrigger = documentRoot ?? undefined;
		onActivate?.();
		session.selected = id;
		if (id === 'composer') focusComposer();
		if (!session.readOnly && !session.viewer) void session.loadViewer();
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
				dismissedSelection = undefined;
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

		const observer = new ResizeObserver(schedule);
		if (rail) observer.observe(rail);
		if (layout) observer.observe(layout);
		document.addEventListener('selectionchange', updateSelection);
		document.addEventListener('pointerdown', pointerDown);
		window.addEventListener('pointerup', pointerUp);
		window.addEventListener('pointercancel', pointerUp);
		window.addEventListener('blur', blur);
		window.addEventListener('resize', resize);
		schedule();
		return () => {
			observer.disconnect();
			document.removeEventListener('selectionchange', updateSelection);
			document.removeEventListener('pointerdown', pointerDown);
			window.removeEventListener('pointerup', pointerUp);
			window.removeEventListener('pointercancel', pointerUp);
			window.removeEventListener('blur', blur);
			window.removeEventListener('resize', resize);
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
		selectionGeometryListeners.clear();
		domCache = undefined;
		if (frame !== undefined) cancelAnimationFrame(frame);
	});
</script>

<BoxDismissal
	owner={interactionOwner}
	active={active && !obscured && Boolean(session.selected)}
	onDismiss={dismissPanel}
	deferEscape={() => {
		const focused = document.activeElement;
		return Boolean(
			rail?.contains(focused) &&
			(focused instanceof HTMLTextAreaElement ||
				focused?.closest('[data-discussion-reply], [data-discussion-composer]'))
		);
	}}
/>

{#snippet recovery()}
	<div class="flex flex-col gap-2 text-xs">
		<p class="text-danger">Reconnect your account to continue discussions.</p>
		<div class="flex flex-wrap gap-x-3 gap-y-2">
			<InlineAction href={LOGIN_PATH} target="_blank">Log in in another tab</InlineAction>
			<InlineAction onclick={() => session.loadViewer()}>Retry account</InlineAction>
			<InlineAction disabled={!session.canContinueAsBuyer} onclick={() => session.continueAsBuyer()}
				>Continue as Buyer</InlineAction
			>
		</div>
		<p class="text-ink-muted">
			Continue as Buyer changes the author for new messages. Account-owned edits still need that
			account.
		</p>
	</div>
{/snippet}

{#if active}
	{#if !session.readOnly && toolbar}
		<SelectionToolbar
			anchor={toolbar.reference}
			label="Add comment"
			onSelect={begin}
			onClose={dismissToolbar}
		/>
	{/if}
	{#if session.error}
		<div
			class="pointer-events-auto absolute inset-x-3 z-10 flex flex-wrap items-center justify-end gap-3 text-xs text-ink-muted"
			style:top={`${Math.max(documentBottom, bottom) + 8}px`}
		>
			<p role="alert" class="text-danger">{session.error}</p>
			<InlineAction onclick={() => session.retry()}>Retry discussions</InlineAction>
		</div>
	{/if}
{/if}
<DocumentPanelRail
	bind:element={rail}
	height={bottom}
	active={active && !obscured}
	label="Contract discussions"
>
	{#each threads as thread, index (thread.id)}
		{@const showRecovery =
			!session.readOnly &&
			session.authRequired &&
			(session.selected === thread.id || (!session.selected && !session.composer && index === 0))}
		<div
			use:observeCard
			data-discussion-card={thread.id}
			class={[
				'pointer-events-auto absolute inset-x-0 top-0 translate-y-(--discussion-top)',
				positioned.has(thread.id) &&
					'motion-safe:transition-[translate] motion-safe:duration-120 motion-safe:ease-in-out',
				previewEntry && 'motion-safe:animate-[discussion-preview-in_140ms_ease-out_both]',
				session.selected === thread.id && 'z-1'
			]}
			style:--discussion-top={`${positions[thread.id] ?? 0}px`}
		>
			<DiscussionRootCard
				{thread}
				{session}
				canRead={active && !obscured}
				onActivate={() => {
					rememberTrigger();
					onActivate?.();
				}}
				orphaned={!resolved.has(thread.id)}
				recovery={showRecovery ? recovery : undefined}
			>
				{#snippet detail(replyTrigger, onReplyTrigger, deletion)}
					{#if active && !obscured && session.active && session.authorized}
						{#key thread.id}
							<DiscussionThread
								{thread}
								{session}
								canRead={active && !obscured}
								onActivate={() => {
									rememberTrigger();
									onActivate?.();
								}}
								{replyTrigger}
								{onReplyTrigger}
								{deletion}
							/>
						{/key}
					{/if}
				{/snippet}
			</DiscussionRootCard>
			{#if showSellerNameHint && session.selected === thread.id && session.replyComposer(thread.id)}
				<Hint id="sellerCommentName" class="mt-3" />
			{/if}
		</div>
	{/each}
	{#if visibleComposerCard}
		{@const composer = visibleComposerCard}
		<div
			use:composerBoundary={collapseComposer}
			data-discussion-composer
			use:observeCard
			data-discussion-card="composer"
			class={[
				'pointer-events-auto absolute inset-x-0 top-0 translate-y-(--discussion-top)',
				positioned.has('composer') &&
					'motion-safe:transition-[translate] motion-safe:duration-120 motion-safe:ease-in-out',
				session.selected === 'composer' && 'z-1'
			]}
			style:--discussion-top={`${positions.composer ?? 0}px`}
			onfocusin={() => {
				session.selected = 'composer';
			}}
		>
			<DocumentPanelCard label="Add comment" selected={session.selected === 'composer'}>
				<DocumentPanelBody>
					{#if session.selected === 'composer'}
						{#if session.authRequired && (session.selected === 'composer' || !session.threads.length)}{@render recovery()}{/if}
						<div>
							<MessageComposer
								text={composer.text}
								author={session.viewer}
								viewerKey={session.viewer?.key}
								perspective={session.perspective()}
								title="Add comment"
								placeholder="Write a comment…"
								submitLabel={composer.awaitingConfirmation ? 'Retry' : 'Comment'}
								closeLabel="Cancel"
								pending={composer.busy}
								textLocked={composer.awaitingConfirmation}
								errorMessage={composer.error ?? session.error ?? ''}
								onTextChange={(text) => session.updateComposerText(text)}
								onClose={() => collapseComposer(true)}
								onSubmit={() => session.submit()}
							/>
						</div>
					{/if}
				</DocumentPanelBody>
			</DocumentPanelCard>
			{#if showSellerNameHint && session.selected === 'composer'}
				<Hint id="sellerCommentName" class="mt-3" />
			{/if}
		</div>
	{/if}
	{#if session.showReconnectCard}
		<DocumentPanelCard label="Reconnect your account">
			<DocumentPanelBody>{@render recovery()}</DocumentPanelBody>
		</DocumentPanelCard>
	{/if}
</DocumentPanelRail>
