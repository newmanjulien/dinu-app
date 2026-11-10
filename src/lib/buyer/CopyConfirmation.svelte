<script lang="ts">
	import StatusBubble from '$lib/components/chrome/StatusBubble.svelte';
	import { getBuyerLinkCopyFeedback } from './copy-feedback.svelte';
	const feedback = getBuyerLinkCopyFeedback();
</script>

<!-- Keep the approved Changes saved style and Home search clearance. See AGENTS.md. -->
{#key feedback.confirmation}
	{#if feedback.confirmation}
		<div class="-translate-y-2">
			<StatusBubble>{feedback.confirmation.message}</StatusBubble>
		</div>
	{/if}
{/key}
