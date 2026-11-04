<script lang="ts">
	import { getAnnotationRegistry } from '$lib/document/annotation-registry';
	import type { AnnotationActivation } from '$lib/document/annotation-anchor';
	import type { StructuralBoundary } from '$lib/contract/source-index';
	import { annotationSegment, type AnnotationMembership } from '$lib/playbook/document-overlay';
	import { protectedInteraction } from '$lib/components/ui/interactions';
	import { BookmarkSimple } from 'phosphor-svelte';

	const registry = getAnnotationRegistry();
	const protect = protectedInteraction();
	let {
		boundary,
		annotations = [],
		selected = false,
		interactive,
		navigationCapable,
		canOpenPlaybookItems,
		onAnnotationSelect
	}: {
		boundary: StructuralBoundary;
		annotations?: readonly AnnotationMembership[];
		selected?: boolean;
		interactive: boolean;
		navigationCapable: boolean;
		canOpenPlaybookItems: boolean;
		onAnnotationSelect: (
			itemId: string,
			annotationId: string,
			activation: AnnotationActivation
		) => void;
	} = $props();
	const segment = $derived(annotationSegment(annotations));
	const saved = $derived(Boolean(segment.target) && navigationCapable);
	function register(owner: HTMLElement, ids: readonly string[]) {
		let release = registry?.register(owner, ids);
		return {
			update(next: readonly string[]) {
				release?.();
				release = registry?.register(owner, next);
			},
			destroy() {
				release?.();
			}
		};
	}
</script>

{#if saved}
	<button
		type="button"
		data-document-control
		use:protect={interactive}
		use:register={segment.membershipIds}
		class="structural-boundary-anchor"
		class:selected
		aria-label="Open clause insertion instructions"
		title="Clause insertion instructions"
		aria-disabled={!interactive || !canOpenPlaybookItems}
		onclick={(event) => {
			event.stopPropagation();
			if (!interactive || !canOpenPlaybookItems || !segment.target) return;
			onAnnotationSelect(segment.target.itemId, segment.target.id, { owner: event.currentTarget });
		}}
	>
		<span
			data-structural-boundary-anchor={boundary.afterBlockKey}
			data-annotation-boundary={boundary.afterBlockKey}
		>
			<BookmarkSimple size={14} weight="bold" />
		</span>
	</button>
{/if}

<style>
	.structural-boundary-anchor {
		position: absolute;
		top: calc(100% + 1px);
		left: -32px;
		z-index: 1;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 1px solid var(--color-edge);
		border-radius: var(--radius-button-sm);
		background: var(--color-surface);
		color: var(--color-success);
		cursor: pointer;
	}
	.structural-boundary-anchor:hover,
	.structural-boundary-anchor:focus-visible,
	.structural-boundary-anchor.selected {
		color: var(--color-accent);
		border-color: var(--color-accent);
		outline: none;
	}
	.structural-boundary-anchor[aria-disabled='true'] {
		cursor: default;
	}
</style>
