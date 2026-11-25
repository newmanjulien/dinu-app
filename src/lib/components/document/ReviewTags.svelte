<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import { ReviewAnchorProjector, type ReviewAnchor } from '$lib/document/review-anchors';
	import {
		availableReviewDecisions,
		type ReviewTag,
		type ReviewNavigation,
		type ReviewDecision
	} from '$lib/contract/approval';
	import type { SelectionDocument } from '$lib/document/selection/selection-model';
	import type { PaginatedPage } from '$lib/document/pagination/types';
	import { revealInDocumentViewport } from '$lib/document/document-viewport';
	import { reviewTagExplanation } from './review-tag-copy';
	let {
		host,
		tags,
		navigation,
		onDecision,
		ready,
		visible,
		document,
		pages
	}: {
		host?: HTMLElement;
		tags: readonly ReviewTag[];
		navigation?: ReviewNavigation;
		onDecision?: (tag: ReviewTag, status: ReviewDecision) => void;
		ready: boolean;
		visible: boolean;
		document?: SelectionDocument;
		pages: readonly PaginatedPage[];
	} = $props();
	let anchors = $state.raw<ReviewAnchor[]>([]);
	let projectionPending = $state(true);
	let openKey = $state<string | null>(null);
	const elements = new SvelteMap<string, HTMLButtonElement>();
	const id = $props.id();
	const projector = new ReviewAnchorProjector();
	const decisionLabels: Record<ReviewDecision, string> = {
		approve: 'Approve concession',
		decline: 'Decline concession'
	};
	const actions = (tag: ReviewTag): readonly ReviewDecision[] =>
		availableReviewDecisions(tag.status);
	const actionable = (tag: ReviewTag) => actions(tag).length > 0;
	const tagsByItem = $derived(new Map<string, ReviewTag>(tags.map((tag) => [tag.itemId, tag])));
	// Status changes update labels without reading document geometry again.
	const geometryKey = $derived(JSON.stringify(tags.map((t) => [t.itemId, t.targets])));
	$effect(() => {
		const root = host,
			mountedDocument = document,
			shown = visible;
		const key = geometryKey,
			mountedPages = pages;
		// Retry geometry after the viewer finishes preparing or becomes interactive again.
		void ready;
		let cancelled = false;
		projectionPending = true;
		void tick().then(() => {
			if (!cancelled) {
				anchors =
					root && mountedDocument && shown
						? untrack(() => projector.project(root, tags, mountedDocument, mountedPages, key))
						: [];
				projectionPending = false;
			}
		});
		return () => {
			cancelled = true;
		};
	});
	$effect(() => {
		const openAnchor = openKey ? anchors.find((anchor) => anchor.key === openKey) : undefined;
		const current = openAnchor ? tagsByItem.get(openAnchor.itemId) : undefined;
		if (!ready || !current?.admin || current.disabled || !actionable(current)) openKey = null;
	});
	function register(node: HTMLButtonElement, key: string) {
		elements.set(key, node);
		return {
			destroy() {
				elements.delete(key);
			}
		};
	}
	let consumed: ReviewNavigation | undefined;
	$effect(() => {
		const request = navigation,
			root = host;
		if (!ready || projectionPending || !request || request === consumed || !root) return;
		const ordered = [...anchors].sort(
			(a, b) => a.order - b.order || a.page - b.page || a.target - b.target
		);
		const after = ordered.findIndex((a) => a.itemId === request.afterItemId);
		let firstPending: ReviewAnchor | undefined, nextPending: ReviewAnchor | undefined;
		for (let i = 0; i < ordered.length; i++) {
			const anchor = ordered[i];
			if (
				anchor.itemId === request.afterItemId ||
				tagsByItem.get(anchor.itemId)?.status !== 'pending'
			)
				continue;
			firstPending ??= anchor;
			if (i > after) nextPending ??= anchor;
		}
		const target = request.afterItemId
			? (nextPending ?? firstPending)
			: (firstPending ?? ordered[0]);
		let cancelled = false;
		void tick().then(() => {
			if (cancelled) return;
			consumed = request;
			openKey = null;
			if (request.afterItemId && !target) return;
			const node = target ? elements.get(target.key) : root;
			if (!node) return;
			if (!target) root.setAttribute('tabindex', '-1');
			node.focus({ preventScroll: true });
			revealInDocumentViewport(node, {
				block: 'start',
				inline: target ? 'nearest' : 'none',
				inlineInset: target ? 8 : 0,
				behavior: 'smooth'
			});
		});
		return () => {
			cancelled = true;
		};
	});
	function label(tag: ReviewTag) {
		return tag.status === 'pending'
			? tag.admin
				? 'Review'
				: 'Pending...'
			: tag.status === 'approved'
				? 'Approved'
				: 'Declined';
	}
</script>

<!-- The page covers the rightmost 8px of each tab; center the label in the exposed area. -->
<div
	class="absolute top-0 left-[calc(0px-var(--review-gutter))] z-0 w-(--review-gutter)"
	aria-label="Contract reviews"
>
	{#each anchors as anchor, i (anchor.key)}
		{@const tag = tagsByItem.get(anchor.itemId)}
		{#if tag}
			{@const explanation = reviewTagExplanation(tag, ready)}
			{@const canOpen = tag.admin && actionable(tag)}
			<Tooltip
				text={explanation}
				trigger={elements.get(anchor.key)}
				standalone={false}
				enabled={openKey !== anchor.key}
			>
				{#snippet children(descriptionId)}
					<button
						type="button"
						class={[
							'absolute left-0 flex h-8.5 w-[calc(100%+8px)] cursor-pointer items-center justify-center gap-1 rounded-l-lg border-0 pr-2 font-sans text-[13px] font-normal leading-[1.2] whitespace-nowrap shadow-control focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent aria-disabled:cursor-default',
							!tag.admin && tag.status === 'pending'
								? 'bg-control-fill text-ink-muted'
								: tag.status === 'approved'
									? 'bg-[color-mix(in_srgb,var(--color-success)_90%,white)] text-white'
									: tag.status === 'rejected'
										? 'bg-[color-mix(in_srgb,var(--color-danger)_90%,white)] text-white'
										: 'bg-[color-mix(in_srgb,var(--color-accent)_90%,white)] text-white'
						]}
						style:top={`${anchor.top}px`}
						use:register={anchor.key}
						aria-label={`${label(tag)}: ${tag.description}`}
						aria-describedby={descriptionId}
						aria-disabled={!canOpen || tag.disabled || !ready}
						aria-haspopup={canOpen ? 'menu' : undefined}
						aria-expanded={canOpen ? openKey === anchor.key : undefined}
						aria-controls={canOpen && openKey === anchor.key ? `${id}-${i}` : undefined}
						onclick={() => {
							if (canOpen && !tag.disabled && ready)
								openKey = openKey === anchor.key ? null : anchor.key;
						}}
						onkeydown={(event) => {
							if (
								canOpen &&
								!tag.disabled &&
								ready &&
								(event.key === 'ArrowDown' || event.key === 'ArrowUp')
							) {
								event.preventDefault();
								openKey = anchor.key;
							}
						}}
					>
						{label(tag)}{#if canOpen}<CaretDownIcon
								aria-hidden="true"
								weight="bold"
								class="size-3"
							/>{/if}
					</button>
				{/snippet}
			</Tooltip>
			{#if tag.error}<p
					role="alert"
					class="absolute left-0 z-30 w-64 rounded-md bg-surface p-2 text-xs text-danger shadow-control"
					style:top={`${anchor.top + 38}px`}
				>
					{tag.error}
				</p>{/if}
			{#if canOpen && openKey === anchor.key}
				<Menu
					open={true}
					placement="bottom-start"
					trigger={elements.get(anchor.key)}
					onClose={() => {
						openKey = null;
					}}
					id={`${id}-${i}`}
					label={`Review ${tag.description}`}
				>
					{#snippet children(close)}
						{#each actions(tag) as action}
							<MenuItem
								disabled={tag.disabled || !ready}
								onclick={() => {
									if (!ready || tag.disabled) return;
									close();
									onDecision?.(tag, action);
								}}>{decisionLabels[action]}</MenuItem
							>
						{/each}
					{/snippet}
				</Menu>
			{/if}
		{/if}
	{/each}
</div>
