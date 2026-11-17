<script lang="ts">
	import InlineAction from '$lib/components/playbook/InlineAction.svelte';
	import type { DiscussionSession } from './session.svelte';

	let {
		session,
		source,
		label
	}: {
		session: DiscussionSession;
		source: string;
		label: string;
	} = $props();
	const operation = $derived(session.work.operations.get(source));
	const checkResultId = $derived(session.checkableOperationId(source));
</script>

{#if session.hasOperationStatus(source) && operation}
	<div class="text-xs text-ink-muted" role="status">
		{#if operation.blocked}
			<p>The result of your {label} is unavailable. Review the discussion before trying again.</p>
			<InlineAction onclick={() => session.clearBlockedOperation(source, operation.id)}
				>Dismiss status</InlineAction
			>
		{/if}
		{#if checkResultId}
			<InlineAction onclick={() => void session.checkOperation(source, checkResultId)}
				>Check result</InlineAction
			>
		{/if}
	</div>
{/if}
