<script lang="ts">
	import { getInteractionController } from '$lib/components/ui/interactions';
	let {
		owner,
		active,
		onDismiss,
		deferEscape
	}: {
		owner: symbol;
		active: boolean;
		onDismiss: (restoreFocus: boolean) => void;
		deferEscape?: () => boolean;
	} = $props();
	const interactions = getInteractionController();
	$effect(() => {
		if (!active) return;
		return interactions.register({
			id: owner,
			kind: 'panel',
			deferEscape: () => deferEscape?.() ?? false,
			elements: () => [],
			close: (reason) => onDismiss(reason === 'escape')
		});
	});
</script>
