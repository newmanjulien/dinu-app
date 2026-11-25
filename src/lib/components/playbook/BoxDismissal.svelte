<script lang="ts">
	import { getInteractionController } from '$lib/components/ui/interactions';
	let {
		owner,
		active,
		dismissOnOutsidePointer = true,
		onDismiss,
		deferEscape
	}: {
		owner: symbol;
		active: boolean;
		dismissOnOutsidePointer?: boolean;
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
			close: (reason) => {
				if (reason === 'outside-pointer' && !dismissOnOutsidePointer) return;
				onDismiss(reason === 'escape');
			}
		});
	});
</script>
