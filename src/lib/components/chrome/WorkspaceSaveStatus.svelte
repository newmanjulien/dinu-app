<script lang="ts">
	import { getWorkspaceFeedback } from './workspace-feedback.svelte';
	import StatusBubble from './StatusBubble.svelte';
	import { getTemplateAuthoringSession } from '$lib/playbook/template-authoring-session.svelte';
	const authoring = getTemplateAuthoringSession('rep');
	const buyers = getTemplateAuthoringSession('buyer');
	const feedback = getWorkspaceFeedback();
	let { completionNotice = null }: { completionNotice?: string | null } = $props();
	const label = $derived(
		(buyers.needsAttention ? buyers.status : null) ??
			(authoring.needsAttention ? authoring.status : null) ??
			feedback.label ??
			completionNotice
	);
</script>

{#if label}
	<StatusBubble
		urgent={Boolean(feedback.attention.length || authoring.needsAttention || buyers.needsAttention)}
	>
		{label}
	</StatusBubble>
{/if}
