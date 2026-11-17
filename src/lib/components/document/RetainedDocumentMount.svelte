<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getDocumentNavigation } from '$lib/document/runtime/navigation.svelte';
	const navigation = getDocumentNavigation();
	let {
		target,
		visible,
		interactive,
		resource,
		children
	}: {
		target?: HTMLElement;
		visible: boolean;
		interactive: boolean;
		resource?: string;
		children: Snippet;
	} = $props();
	let element = $state<HTMLDivElement>();
	let parking = $state<HTMLDivElement>();
	// Reparent the existing subtree so reopening reuses page nodes and annotation owners.
	$effect(() => {
		const node = element,
			destination = target ?? parking;
		if (node && destination && node.parentElement !== destination) {
			destination.append(node);
			navigation?.placementChanged();
		}
		return () => {
			if (node && parking && node.parentElement !== parking) parking.append(node);
		};
	});
</script>

<div
	bind:this={parking}
	class="pointer-events-none invisible fixed top-0 left-[-100000px] w-full [contain:layout_paint]"
	inert
	aria-hidden="true"
>
	<div
		bind:this={element}
		data-document-resource={resource}
		class={!visible
			? 'pointer-events-none invisible fixed top-0 left-[-100000px] w-full [contain:layout_paint]'
			: ''}
		inert={!interactive}
		aria-hidden={!visible}
	>
		{@render children()}
	</div>
</div>
