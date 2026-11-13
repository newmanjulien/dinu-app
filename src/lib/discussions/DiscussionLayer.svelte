<script lang="ts">
	import { onMount, onDestroy, tick, untrack } from 'svelte';
	import ChatCenteredTextIcon from 'phosphor-svelte/lib/ChatCenteredTextIcon';
	import EraserIcon from 'phosphor-svelte/lib/EraserIcon';
	import type { DiscussionSession } from './session.svelte';
	import type { DiscussionAnchor } from './validators';
	import type { DocumentHighlightController } from '$lib/document/highlights/controller';
	import DocumentPanelRail from '$lib/components/document/DocumentPanelRail.svelte';
	import PlaybookCard from '$lib/components/playbook/PlaybookCard.svelte';
	import InlineAction from '$lib/components/playbook/InlineAction.svelte';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import { captureDiscussionAnchor, discussionDomRange, indexDiscussionDom } from './dom-anchor';
	import { packAnnotationRail } from './annotation-rail-layout';
	import DiscussionThread from './DiscussionThread.svelte';
	import MessageComposer from './MessageComposer.svelte';
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
		if (!restore && !session.replyingTo && !session.editingMessage) return;
		if (session.selected === 'composer') {
			if (!restore || session.drafts.submitting) return;
			session.cancel();
		} else {
			session.closeEditors();
			session.selected = null;
		}
		if (restore && openingTrigger?.isConnected) openingTrigger.focus({ preventScroll: true });
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
		anchors = $state.raw<Record<string, number>>({}),
		resolved = $state.raw<Set<string>>(new Set()),
		bottom = $state(0);
	let toolbar = $state.raw<{
		reference: FloatingVirtualAnchor;
		anchor: DiscussionAnchor;
	} | null>(null);
	const selectionGeometryListeners = new Set<() => void>();
	let dismissedSelection: string | undefined;
	let alive = true;
	let ranges = $state.raw(new Map<string, Range>());
	let documentBottom = $state(0);
	$effect(() => {
		if (!active || obscured) session.closeEditors();
	});
	let frame: number | undefined,
		selectionPointer: number | null = null;
	const cards = $derived([
		...session.threads.map((t) => ({
			id: t.id,
			anchor: t.anchor,
			type: t.type,
			available: session.feed.authorized
		})),
		...(session.visibleComposer
			? [
					{
						id: 'composer',
						anchor: session.visibleComposer.anchor,
						type: session.visibleComposer.type,
						available: session.visibleComposer.contentIdentity === session.contentIdentity()
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
						card.id === 'composer'
							? 'authoring-selection'
							: card.type === 'proposal'
								? 'discussion-proposal'
								: 'buyer-attachment',
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
			anchors = {};
			resolved = new Set();
			positions = {};
			bottom = 0;
			documentBottom = active ? (layout?.getBoundingClientRect().height ?? 0) : 0;
			return;
		}
		const base = layout.getBoundingClientRect(),
			next: Record<string, number> = {};
		documentBottom = base.height;
		const items = cards.map((card, order) => {
			const rect = card.available
				? highlights?.annotationAnchorRect(groupName(card.id))
				: undefined;
			if (rect) next[card.id] = Math.max(0, rect.top - base.top);
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
		anchors = next;
		resolved = new Set(ranges.keys());
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
		if (!active) {
			toolbar = null;
		}
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
	function begin(type: 'comment' | 'proposal') {
		if (session.readOnly || !toolbar) return;
		rememberTrigger();
		onActivate?.();
		session.begin(toolbar.anchor, type);
		focusDraft();
		toolbar = null;
		window.getSelection()?.removeAllRanges();
	}
	function focusDraft() {
		const current = session.captureWriteAccess();
		void tick().then(() => {
			if (
				current() &&
				active &&
				!obscured &&
				session.selected === 'composer' &&
				!session.drafts.submitting
			)
				rail
					?.querySelector<HTMLTextAreaElement>('[data-discussion-card="composer"] textarea')
					?.focus({ preventScroll: true });
		});
	}
	export function activate(id: string, restoreToDocument = false) {
		if (session.readOnly && id === 'composer') return;
		rememberTrigger();
		if (restoreToDocument || !openingTrigger || openingTrigger === document.body)
			openingTrigger = documentRoot ?? undefined;
		onActivate?.();
		session.selected = id;
		if (id === 'composer') focusDraft();
		if (!session.readOnly) void session.loadBuyerViewer();
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
		<p class="text-danger">Your draft is still here. Reconnect your account, then retry.</p>
		<div class="flex flex-wrap gap-x-3 gap-y-2">
			<InlineAction href="/login" target="_blank">Sign in in another tab</InlineAction>
			<InlineAction onclick={() => session.loadBuyerViewer()}>Retry account</InlineAction>
			<InlineAction disabled={!session.canContinueAsBuyer} onclick={() => session.continueAsBuyer()}
				>Continue as Buyer</InlineAction
			>
		</div>
		<p class="text-ink-muted">
			Continue as Buyer changes the author for new messages. Pending account submissions and
			account-owned edits still need that account.
		</p>
	</div>
{/snippet}

{#if active}
	{#if !session.readOnly && toolbar}
		<SelectionToolbar
			anchor={toolbar.reference}
			onClose={dismissToolbar}
			actions={[
				{
					id: 'comment',
					label: 'Add comment',
					icon: ChatCenteredTextIcon,
					onSelect: () => begin('comment')
				},
				{
					id: 'proposal',
					label: 'Propose change',
					icon: EraserIcon,
					onSelect: () => begin('proposal')
				}
			]}
		/>
	{/if}
	{#if session.threads.length || session.visibleComposer || session.error || (!session.loading && !session.done)}
		<div
			class="pointer-events-auto absolute inset-x-3 z-10 flex flex-wrap items-center justify-end gap-3 text-xs text-ink-muted"
			style:top={`${Math.max(documentBottom, bottom) + 8}px`}
		>
			{#if session.visibleComposer && session.selected !== 'composer'}
				<InlineAction onclick={() => activate('composer')}>Continue draft</InlineAction>
			{/if}
			{#if session.threads.length}<span class="@min-[1150px]:hidden"
					><InlineAction onclick={() => activate(session.threads[0].id)}
						>View discussions</InlineAction
					></span
				>{/if}
			{#if !session.done && !session.error}<InlineAction
					disabled={session.loading}
					onclick={() => session.loadMore()}>More discussions</InlineAction
				>{/if}
			{#if session.error}<p role="alert" class="text-danger">{session.error}</p>
				<InlineAction onclick={() => session.retry()}>Retry discussions</InlineAction>{/if}
		</div>
	{/if}
{/if}
<DocumentPanelRail
	bind:element={rail}
	height={bottom}
	active={active && !obscured}
	label="Contract discussions"
>
	{#each session.threads as thread, index (thread.id)}
		{@const showRecovery =
			!session.readOnly &&
			session.authRequired &&
			(session.selected === thread.id ||
				(!session.selected && !session.drafts.composer && index === 0))}
		<div
			use:observeCard
			data-discussion-card={thread.id}
			class={[
				'pointer-events-auto absolute inset-x-0 top-0 @min-[1150px]:translate-y-(--discussion-top) @max-[1150px]:static',
				session.selected !== thread.id && !showRecovery && '@max-[1150px]:hidden'
			]}
			style:--discussion-top={`${positions[thread.id] ?? 0}px`}
		>
			<DiscussionThread
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
				{#snippet header()}
					<div
						class="flex items-center justify-end gap-3 px-3 pt-2 pb-1 text-xs @min-[1150px]:hidden"
					>
						<InlineAction
							disabled={index === 0}
							onclick={() => activate(session.threads[index - 1].id)}>Previous</InlineAction
						>
						<InlineAction
							disabled={index === session.threads.length - 1}
							onclick={() => activate(session.threads[index + 1].id)}>Next</InlineAction
						>
						<SquareIconButton aria-label="Close discussion" onclick={() => dismissPanel(true)}
							><XIcon aria-hidden="true" class="size-5.5" /></SquareIconButton
						>
					</div>
				{/snippet}
			</DiscussionThread>
		</div>
	{/each}
	{#if session.visibleComposer}
		<div
			use:observeCard
			data-discussion-card="composer"
			class={[
				'pointer-events-auto absolute inset-x-0 top-0 @min-[1150px]:translate-y-(--discussion-top) @max-[1150px]:static',
				session.selected !== 'composer' && '@max-[1150px]:hidden'
			]}
			style:--discussion-top={`${positions.composer ?? 0}px`}
			onfocusin={() => (session.selected = 'composer')}
		>
			<PlaybookCard
				label={session.visibleComposer.type === 'proposal' ? 'Propose change' : 'Add comment'}
			>
				{#if session.authRequired && (session.selected === 'composer' || !session.threads.length)}{@render recovery()}{/if}
				<div data-discussion-composer>
					<MessageComposer
						allowDeletion={session.visibleComposer.type === 'proposal'}
						text={session.drafts.text}
						author={session.viewer}
						viewerKey={session.viewer?.key}
						title={session.visibleComposer.type === 'proposal' ? 'Propose change' : 'Add comment'}
						placeholder={session.visibleComposer.type === 'proposal'
							? 'Write the proposed wording or change…'
							: 'Write a comment…'}
						submitLabel={session.visibleComposer.type === 'proposal' ? 'Propose change' : 'Comment'}
						cancelLabel="Cancel"
						submitOnEnter
						pending={session.drafts.submitting}
						errorMessage={session.drafts.composeError ?? session.error ?? ''}
						onTextChange={(text) => (session.drafts.text = text)}
						onCancel={() => session.cancel()}
						onSubmit={() => void session.submit()}
					/>
				</div>
			</PlaybookCard>
		</div>
	{/if}
	{#if !session.readOnly && session.authRequired && !session.threads.length && !session.drafts.composer}
		<PlaybookCard label="Reconnect your account">{@render recovery()}</PlaybookCard>
	{/if}
</DocumentPanelRail>
