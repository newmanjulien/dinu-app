<script lang="ts">
	import { getAnnotationRegistry } from '$lib/document/annotation-registry';
	import type { AnnotationActivation } from '$lib/document/annotation-anchor';
	import type { StructuralBoundary } from '$lib/contract/source-index';
	import type { AnnotationMembership } from '$lib/playbook/document-overlay';
	import { protectedInteraction } from '$lib/components/ui/interactions';
	import { BookmarkSimple } from 'phosphor-svelte';

	const registry = getAnnotationRegistry();
	const protect = protectedInteraction();
	let {
		boundary,
		annotation,
		pageNumber,
		selected = false,
		inline = false,
		interactive,
		navigationCapable,
		canOpenPlaybookItems,
		onAnnotationSelect
	}: {
		boundary: StructuralBoundary;
		annotation: AnnotationMembership;
		pageNumber?: number;
		selected?: boolean;
		inline?: boolean;
		interactive: boolean;
		navigationCapable: boolean;
		canOpenPlaybookItems: boolean;
		onAnnotationSelect: (
			itemId: string,
			annotationId: string,
			activation: AnnotationActivation
		) => void;
	} = $props();

	const saved = $derived(navigationCapable);
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
		use:register={[annotation.id]}
		data-page-number={pageNumber}
		class={`${inline ? 'relative shrink-0' : 'absolute top-0 -left-8'} z-1 grid size-6 cursor-pointer place-items-center rounded-button-sm border bg-surface p-0 hover:border-accent hover:text-accent hover:outline-none focus-visible:border-accent focus-visible:text-accent focus-visible:outline-none aria-disabled:cursor-default ${selected ? 'border-accent text-accent outline-none' : 'border-edge text-success'}`}
		aria-label="Open saved instructions"
		title="Saved instructions"
		aria-disabled={!interactive || !canOpenPlaybookItems || Boolean(annotation.pending)}
		onclick={(event) => {
			event.stopPropagation();
			if (!interactive || !canOpenPlaybookItems || annotation.pending) return;
			onAnnotationSelect(annotation.itemId, annotation.id, { owner: event.currentTarget });
		}}
	>
		<span
			data-structural-boundary-anchor={boundary.afterBlockKey}
			data-annotation-boundary={annotation.target.kind === 'boundary'
				? annotation.target.afterBlockKey
				: undefined}
			data-visual-source={JSON.stringify(annotation.target)}
		>
			<BookmarkSimple class="size-3.5" weight="bold" />
		</span>
	</button>
{/if}
