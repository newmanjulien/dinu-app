<script lang="ts">
	import { packAnnotationRail } from '$lib/discussions/annotation-rail-layout';
	import { tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import { ReviewAnchorProjector, type ReviewAnchor } from '$lib/document/review-anchors';
	import type { ReviewTag, ReviewNavigation, ReviewDecision } from '$lib/contract/approval';
	import type { SelectionDocument } from '$lib/document/selection/selection-model';
	import type { PaginatedPage } from '$lib/document/pagination/types';
	import { getDocumentViewportMetrics } from '$lib/document/document-viewport';
	import { reviewTagExplanation } from './review-tag-copy';
	let {
		host,
		tags,
		navigation,
		onDecision,
		ready,
		visible,
		document,
		pages,
		scale
	}: {
		host?: HTMLElement;
		tags: readonly ReviewTag[];
		navigation?: ReviewNavigation;
		onDecision?: (tag: ReviewTag, status: ReviewDecision) => void;
		ready: boolean;
		visible: boolean;
		document?: SelectionDocument;
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
		approve: 'Approve change',
		decline: 'Decline change',
		undo: 'Undo approved change'
	};
	const actions = (tag: ReviewTag): ReviewDecision[] =>
		tag.status === 'approved'
			? tag.kind === 'buyer-link'
				? ['undo']
				: []
			: ['approve', 'decline'];
	const eligibility = (tag: ReviewTag, action: ReviewDecision) =>
		action === 'approve' ? tag.approve : action === 'decline' ? tag.decline : tag.undo;
	const actionable = (tag: ReviewTag) =>
		actions(tag).some((action) => eligibility(tag, action).allowed === true);
	const tagsByChange = $derived(new Map<string, ReviewTag>(tags.map((tag) => [tag.changeId, tag])));
	// Status changes update labels without reading document geometry again.
	const geometryKey = $derived(JSON.stringify(tags.map((t) => [t.changeId, t.target])));
	$effect(() => {
		const root = host,
			mountedDocument = document,
			shown = visible;
		const key = geometryKey,
			mountedPages = pages,
			pageScale = scale;
		// Retry geometry after the viewer finishes preparing or becomes interactive again.
		void ready;
		let cancelled = false;
		projectionPending = true;
		void tick().then(() => {
			if (!cancelled) {
				anchors =
					root && mountedDocument && shown
						? untrack(() =>
								(() => {
									const projected = projector.project(
										root,
										tags,
										mountedDocument,
										mountedPages,
										pageScale,
										key
									);
									if (!tags.some((tag) => tag.kind === 'buyer-link')) return projected;
									const packed = packAnnotationRail(
										projected.map((anchor, order) => ({
											id: anchor.key,
											anchorTop: anchor.top,
											height: 34,
											order
										}))
									);
									return projected.map((anchor) => ({
										...anchor,
										top: packed.placements[anchor.key]
									}));
								})()
							)
						: [];
				projectionPending = false;
			}
		});
		return () => {
			cancelled = true;
		};
	});
	$effect(() => {
		const current = openKey ? tagsByChange.get(openKey) : undefined;
		if (
			!ready ||
			!current?.admin ||
			current.disabled ||
			!actionable(current) ||
			!anchors.some((anchor) => anchor.key === openKey)
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
		const after = ordered.findIndex((a) => a.changeId === request.afterChangeId);
		let firstPending: ReviewAnchor | undefined, nextPending: ReviewAnchor | undefined;
		for (let i = 0; i < ordered.length; i++) {
			const anchor = ordered[i];
			if (
				anchor.changeId === request.afterChangeId ||
				tagsByChange.get(anchor.changeId)?.status !== 'pending'
			)
				continue;
			firstPending ??= anchor;
			if (i > after) nextPending ??= anchor;
		}
		const target = request.afterChangeId
			? (nextPending ?? firstPending)
			: (firstPending ?? ordered[0]);
		let cancelled = false;
		void tick().then(() => {
			if (cancelled) return;
			consumed = request;
			openKey = null;
			if (request.afterChangeId && !target) return;
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
		return tag.detailRequired && tag.admin
			? 'Checking…'
			: tag.status === 'pending'
				? tag.kind === 'buyer-link'
					? 'Pending'
					: tag.admin
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
		{@const tag = tagsByChange.get(anchor.changeId)}
		{#if tag}
			{@const explanation = reviewTagExplanation(tag, ready)}
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
						aria-disabled={!tag.admin || tag.disabled || !ready || !actionable(tag)}
						aria-haspopup={tag.admin ? 'menu' : undefined}
						aria-expanded={tag.admin ? openKey === anchor.key : undefined}
						aria-controls={tag.admin && openKey === anchor.key ? `${id}-${i}` : undefined}
						onclick={() => {
							if (tag.admin && !tag.disabled && ready && actionable(tag))
								openKey = openKey === anchor.key ? null : anchor.key;
						}}
						onkeydown={(event) => {
							if (
								tag.admin &&
								actionable(tag) &&
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
			{#if tag.error}<p
					role="alert"
					class="absolute left-0 z-30 w-64 rounded-md bg-surface p-2 text-xs text-danger shadow-control"
					style:top={`${anchor.top + 38}px`}
				>
					{tag.error}
				</p>{/if}
			{#if tag.admin && openKey === anchor.key}
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
							{@const permission = eligibility(tag, action)}
							<MenuItem
								disabled={tag.disabled || !ready || permission.allowed !== true}
								title={permission.reason ??
									(permission.allowed === null ? 'Checking this action…' : undefined)}
								onclick={() => {
									if (!ready || tag.disabled || permission.allowed !== true) return;
									close();
									onDecision?.(tag, action);
								}}>{decisionLabels[action]}</MenuItem
							>
							{#if permission.reason}<p class="m-0 px-2 py-1 text-xs text-ink-muted">
									{permission.reason}
								</p>{/if}
						{/each}
					{/snippet}
				</Menu>
			{/if}
		{/if}
	{/each}
</div>
