<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import { ReviewAnchorProjector, type ReviewAnchor } from '$lib/document/review-anchors';
	import type { ReviewTag, ReviewNavigation, ReviewDecision } from '$lib/contract/approval';
	import type { SourceIndex } from '$lib/contract/source-index';
	import type { PaginatedPage } from '$lib/document/pagination/types';
	import { getDocumentViewportMetrics } from '$lib/document/document-viewport';
	import { reviewTagExplanation } from './review-tag-copy';
	let {
		host,
		tags,
		navigation,
		onDecision,
		ready,
		index,
		pages,
		scale
	}: {
		host?: HTMLElement;
		tags: readonly ReviewTag[];
		navigation?: ReviewNavigation;
		onDecision?: (tag: ReviewTag, status: ReviewDecision) => void;
		ready: boolean;
		index?: SourceIndex;
		pages: readonly PaginatedPage[];
		scale: number;
	} = $props();
	let anchors = $state.raw<ReviewAnchor[]>([]);
	let projectionPending = $state(true);
	let openKey = $state<string | null>(null);
	const elements = new SvelteMap<string, HTMLButtonElement>();
	const id = $props.id();
	const projector = new ReviewAnchorProjector();
	const decisionLabels: Record<ReviewDecision, string> = {
		approved: 'Approved',
		rejected: 'Declined'
	};
	const tagsByItem = $derived(new Map(tags.map((tag) => [tag.itemId, tag])));
	// Status changes update labels without reading document geometry again.
	const geometryKey = $derived(JSON.stringify(tags.map((t) => [t.itemId, t.lifecycle, t.range])));
	$effect(() => {
		const root = host,
			source = index;
		const key = geometryKey,
			mountedPages = pages,
			pageScale = scale;
		let cancelled = false;
		projectionPending = true;
		void tick().then(() => {
			if (!cancelled) {
				anchors =
					root && source
						? untrack(() => projector.project(root, tags, source, mountedPages, pageScale, key))
						: [];
				projectionPending = false;
			}
		});
		return () => {
			cancelled = true;
		};
	});
	$effect(() => {
		if (
			!ready ||
			!tags.some((t) => t.admin && !t.disabled) ||
			!anchors.some((a) => a.key === openKey)
		)
			openKey = null;
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
			window.scrollBy({
				top: node.getBoundingClientRect().top - getDocumentViewportMetrics().top,
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
			: decisionLabels[tag.status];
	}
</script>

<div class="review-gutter" aria-label="Concession reviews">
	{#each anchors as anchor, i (anchor.key)}
		{@const tag = tagsByItem.get(anchor.itemId)}
		{#if tag}
			{@const explanation = reviewTagExplanation(tag, ready)}
			<Tooltip
				text={explanation}
				trigger={elements.get(anchor.key)}
				standalone={false}
				enabled={openKey !== anchor.key}
				class="rounded-md border-0 bg-[#fafafa] px-2 py-1 text-left text-xs leading-[1.4] text-[#202124] shadow-sm"
			>
				{#snippet children(descriptionId)}
					<button
						type="button"
						class="review-tab"
						class:approved={tag.status === 'approved'}
						class:rejected={tag.status === 'rejected'}
						class:waiting={!tag.admin && tag.status === 'pending'}
						style:top={`${anchor.top}px`}
						use:register={anchor.key}
						aria-label={`${label(tag)}: ${tag.description}`}
						aria-describedby={descriptionId}
						aria-disabled={!tag.admin || tag.disabled || !ready}
						aria-haspopup={tag.admin ? 'menu' : undefined}
						aria-expanded={tag.admin ? openKey === anchor.key : undefined}
						aria-controls={tag.admin && openKey === anchor.key ? `${id}-${i}` : undefined}
						onclick={() => {
							if (tag.admin && !tag.disabled && ready)
								openKey = openKey === anchor.key ? null : anchor.key;
						}}
						onkeydown={(event) => {
							if (
								tag.admin &&
								!tag.disabled &&
								ready &&
								(event.key === 'ArrowDown' || event.key === 'ArrowUp')
							) {
								event.preventDefault();
								openKey = anchor.key;
							}
						}}
					>
						{label(tag)}{#if tag.admin}<CaretDownIcon
								aria-hidden="true"
								size={12}
								weight="bold"
							/>{/if}
					</button>
				{/snippet}
			</Tooltip>
			{#if tag.admin && openKey === anchor.key}
				<Menu
					open={true}
					trigger={elements.get(anchor.key)}
					onClose={() => {
						openKey = null;
					}}
					id={`${id}-${i}`}
					label={`Review ${tag.description}`}
				>
					{#snippet children(close)}
						{#each ['approved', 'rejected'] as const as status}
							<MenuItem
								checked={tag.status === status}
								disabled={tag.disabled || !ready}
								aria-label={`${decisionLabels[status]}${tag.status === status ? ', current status' : ''}`}
								onclick={() => {
									if (!ready || tag.disabled) return;
									close();
									onDecision?.(tag, status);
								}}
							>
								{decisionLabels[status]}
							</MenuItem>
						{/each}
					{/snippet}
				</Menu>
			{/if}
		{/if}
	{/each}
</div>

<style>
	.review-gutter {
		position: absolute;
		left: calc(0px - var(--review-gutter-width));
		top: 0;
		width: var(--review-gutter-width);
		z-index: 0;
	}
	.review-tab {
		position: absolute;
		left: 0;
		/* The page covers the rightmost 8px; center the label in the exposed tab. */
		width: calc(100% + 8px);
		padding-right: 8px;
		height: 34px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		border: 0;
		border-radius: 3px 0 0 3px;
		background: var(--color-accent);
		color: white;
		font: 400 13px/1.2 var(--font-sans, sans-serif);
		cursor: pointer;
		white-space: nowrap;
		box-shadow: 0 1px 2px #00000018;
	}
	.review-tab:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 3px;
	}
	.review-tab[aria-disabled='true'] {
		cursor: default;
	}
	.approved {
		background: var(--color-success);
	}
	.rejected {
		background: var(--color-danger);
	}
	.waiting {
		background: #e4e6e9;
		color: #535a64;
	}
</style>
