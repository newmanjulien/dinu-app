<script lang="ts">
	import type { AnnotationActivation } from '$lib/document/annotation-anchor';
	import { getAnnotationRegistry } from '$lib/document/annotation-registry';
	import type { AnnotationMembership } from '$lib/playbook/document-overlay';
	import type { BoundaryOption } from '$lib/document/selection/boundary-options';
	import { protectedInteraction, type CloseReason } from '$lib/components/ui/interactions';
	import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
	import StructuralBoundaryAnchor from './StructuralBoundaryAnchor.svelte';
	import { BookmarkSimple } from 'phosphor-svelte';
	let {
		options,
		selectionGroup,
		gap,
		interactive,
		navigationCapable,
		canOpenPlaybookItems,
		annotations,
		selectedAnnotationId,
		onAnnotationSelect
	}: {
		options: readonly BoundaryOption[];
		selectionGroup: number;
		gap: number;
		interactive: boolean;
		navigationCapable: boolean;
		canOpenPlaybookItems: boolean;
		annotations: ReadonlyMap<string, readonly AnnotationMembership[]>;
		selectedAnnotationId: string | null;
		onAnnotationSelect: (
			itemId: string,
			annotationId: string,
			activation: AnnotationActivation
		) => void;
	} = $props();
	const protect = protectedInteraction(),
		registry = getAnnotationRegistry();
	let trigger = $state<HTMLButtonElement>(),
		chooser = $state<HTMLDivElement>();
	let open = $state(false);
	const saved = $derived.by(() => {
		const seen = new Set<string>();
		return options.flatMap(({ boundary, label }) =>
			(annotations.get(boundary.afterBlockKey) ?? []).flatMap((annotation) => {
				if (seen.has(annotation.id)) return [];
				seen.add(annotation.id);
				return [{ boundary, annotation, label }];
			})
		);
	});
	function register(node: HTMLButtonElement, ids: readonly string[]) {
		let release = registry?.register(node, ids);
		return {
			update(next: readonly string[]) {
				release?.();
				release = registry?.register(node, next);
			},
			destroy() {
				release?.();
			}
		};
	}
	function close(reason: CloseReason) {
		open = false;
		if (reason === 'escape') trigger?.focus({ preventScroll: true });
	}
	$effect(() => {
		void options;
		void interactive;
		void navigationCapable;
		open = false;
	});
</script>

<span
	class="structural-boundary-controls"
	data-document-control
	data-selection-group={selectionGroup}
	data-selection-gap={gap}
	style:--boundary-gap={`${gap}px`}
	style:--boundary-gutter="calc(-8px - var(--boundary-handle-size))"
>
	{#each options as { boundary } (boundary.afterBlockKey)}
		<span
			class="structural-boundary-target"
			class:structural-boundary-target--gutter={gap < 1}
			data-structural-boundary={boundary.afterBlockKey}
			aria-hidden="true"
		></span>
	{/each}
	{#if navigationCapable && saved.length > 1}
		<button
			bind:this={trigger}
			use:protect={interactive}
			use:register={saved.map(({ annotation }) => annotation.id)}
			type="button"
			class="structural-boundary-control structural-boundary-control--gutter"
			data-document-control
			aria-label="Open saved instructions"
			aria-expanded={open}
			aria-disabled={!interactive || !canOpenPlaybookItems}
			onclick={(event) => {
				event.preventDefault();
				event.stopPropagation();
				if (interactive && canOpenPlaybookItems) open = !open;
			}}
		>
			{#each saved as { annotation }}<span
					data-visual-source={JSON.stringify(annotation.target)}
					aria-hidden="true"
				></span>{/each}
			<span class="structural-boundary-handle" aria-hidden="true"
				><BookmarkSimple class="size-3.5" /><span class="structural-boundary-count"
					>{saved.length}</span
				></span
			>
		</button>
	{:else if saved[0]}
		<StructuralBoundaryAnchor
			boundary={saved[0].boundary}
			annotation={saved[0].annotation}
			selected={saved[0].annotation.id === selectedAnnotationId}
			{interactive}
			{navigationCapable}
			{canOpenPlaybookItems}
			{onAnnotationSelect}
		/>
	{/if}
</span>{#if open && trigger}
	<FloatingSurface
		bind:element={chooser}
		open={true}
		{trigger}
		role="group"
		label="Saved instructions"
		placement="bottom-start"
		dismissOnFocus
		onClose={close}
		onReady={() =>
			chooser?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })}
		class="max-h-72 max-w-sm rounded-lg border border-edge bg-surface p-2 text-sm text-ink shadow-floating"
	>
		<div data-document-control>
			{#each saved as { boundary, annotation, label }, i (annotation.id)}
				<div class="flex items-center gap-2">
					<span class="flex-1 px-3 py-2">{i + 1}. {label}</span>
					<StructuralBoundaryAnchor
						{boundary}
						{annotation}
						inline
						pageNumber={Number(trigger.closest<HTMLElement>('.document-page')?.dataset.pageNumber)}
						selected={annotation.id === selectedAnnotationId}
						{interactive}
						{navigationCapable}
						{canOpenPlaybookItems}
						onAnnotationSelect={(...args) => {
							open = false;
							onAnnotationSelect(args[0], args[1], { ...args[2], owner: trigger! });
						}}
					/>
				</div>
			{/each}
		</div>
	</FloatingSurface>
{/if}
