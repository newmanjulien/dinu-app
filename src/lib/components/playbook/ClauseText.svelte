<script lang="ts">
	import PlaybookText from './PlaybookText.svelte';
	let { text, animateContent = false }: { text: string; animateContent?: boolean } = $props();
	const hasText = $derived(Boolean(text.trim()));
</script>

{#if hasText}
	<div
		class={`min-w-0 text-ink-muted ${animateContent ? 'motion-safe:animate-[clause-panel-content-in_140ms_ease-out_both]' : ''}`}
	>
		<PlaybookText {text} />
	</div>
{/if}
