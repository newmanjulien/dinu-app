<script lang="ts">
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import PlaybookText from './PlaybookText.svelte';
	let {
		text,
		closeLabel,
		onClose,
		showDesktopClose = false,
		animateContent = false
	}: {
		text: string;
		closeLabel: string;
		onClose: () => void;
		showDesktopClose?: boolean;
		animateContent?: boolean;
	} = $props();
	const hasText = $derived(Boolean(text.trim()));
</script>

<div
	class={`${showDesktopClose ? 'grid' : hasText ? 'block' : 'hidden'} grid-cols-[minmax(0,1fr)_auto] items-center gap-6 @max-[1150px]:grid ${animateContent ? 'motion-safe:animate-[clause-panel-content-in_140ms_ease-out_both]' : ''}`}
>
	<div class="flex min-w-0 flex-col gap-3 text-ink-muted">
		{#if hasText}<PlaybookText {text} />{/if}
	</div>
	<div class={showDesktopClose ? 'block' : 'hidden @max-[1150px]:block'}>
		<SquareIconButton type="button" aria-label={closeLabel} onclick={onClose}>
			<XIcon aria-hidden="true" class="size-5.5" weight="regular" />
		</SquareIconButton>
	</div>
</div>
