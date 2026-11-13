<script lang="ts">
	import type { OperationStatus } from '../../../src/lib/components/chrome/operation-status';
	let { feedback }: { feedback?: OperationStatus | null; [key: string]: unknown } = $props();
</script>

{#if feedback}
	<p role="status">{feedback.message}</p>
	{#each feedback.actions ?? [] as action}
		<button onclick={action.run}>{action.label}</button>
	{/each}
{/if}
