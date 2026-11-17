<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { DocumentAttachmentBinding } from '$lib/document/runtime/resources.svelte';
	let {
		target,
		binding,
		visible,
		interactive,
		resource,
		children
	}: {
		target?: HTMLElement;
		binding?: DocumentAttachmentBinding;
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
		}
		if (node && binding && node.parentElement === binding.target) binding.place(node);
		return () => {
			if (node && binding) binding.unplace(node);
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
