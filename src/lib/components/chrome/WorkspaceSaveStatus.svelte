<script lang="ts">
	import { getWorkspaceFeedback } from './workspace-feedback.svelte';
	import StatusBubble from './StatusBubble.svelte';
	import { getTemplateAuthoringSession } from '$lib/playbook/template-authoring-session.svelte';
	const authoring = getTemplateAuthoringSession();
	const buyers = getTemplateAuthoringSession('buyer');
	const feedback = getWorkspaceFeedback();
	const label = $derived(buyers.status ?? authoring.status ?? feedback.label);
</script>

{#if label}
	<StatusBubble
		urgent={Boolean(feedback.attention.length || authoring.needsAttention || buyers.needsAttention)}
	>
		{label}
	</StatusBubble>
{/if}
