<script lang="ts">
	import StatusBubble from '$lib/components/chrome/StatusBubble.svelte';
	import { getBuyerLinkCopyFeedback } from './copy-feedback.svelte';
	const feedback = getBuyerLinkCopyFeedback();
</script>

<!-- Keep the approved Changes saved style and Home search clearance. See AGENTS.md. -->
{#key feedback.notice}
	{#if feedback.notice}
		<div class="-translate-y-2">
			<StatusBubble urgent={feedback.notice.kind === 'error'}>
				<span class:text-danger={feedback.notice.kind === 'error'}>{feedback.notice.message}</span>
			</StatusBubble>
		</div>
	{/if}
{/key}
