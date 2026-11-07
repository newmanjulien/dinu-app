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
	const geometryKey = $derived(
		JSON.stringify(tags.map((t) => [t.itemId, t.applicationId, t.target]))
	);
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

<!-- The page covers the rightmost 8px of each tab; center the label in the exposed area. -->
<div
	class="absolute top-0 left-[calc(0px-var(--review-gutter))] z-0 w-(--review-gutter)"
	aria-label="Concession reviews"
>
	{#each anchors as anchor, i (anchor.key)}
		{@const tag = tagsByItem.get(anchor.itemId)}
		{#if tag}
			{@const explanation = reviewTagExplanation(tag, ready)}
			<Tooltip
				text={explanation}
				trigger={elements.get(anchor.key)}
				standalone={false}
				enabled={openKey !== anchor.key}
				class="rounded-md border-hairline border-edge bg-surface px-2 py-1 text-left text-xs leading-[1.4] text-ink shadow-floating"
			>
				{#snippet children(descriptionId)}
					<button
						type="button"
						class={[
							'absolute left-0 flex h-8.5 @min-[1150px]:h-[clamp(32px,2.6cqw,34px)] w-[calc(100%+8px)] cursor-pointer items-center justify-center gap-1 @min-[1150px]:gap-[clamp(3px,0.3cqw,4px)] rounded-l-lg border-0 pr-2 font-sans text-[13px] @min-[1150px]:text-[clamp(12px,1cqw,13px)] font-normal leading-[1.2] whitespace-nowrap shadow-control focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent aria-disabled:cursor-default',
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
								weight="bold"
								class="size-3 @min-[1150px]:size-[clamp(11px,0.9cqw,12px)]"
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
