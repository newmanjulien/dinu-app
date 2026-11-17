<script lang="ts">
	import MessageComposer from './MessageComposer.svelte';
	import { composerBoundary } from './focus-composer';

	let {
		id,
		text,
		pending = false,
		checkResultId,
		writeBlocked = false,
		errorMessage = '',
		onTextChange,
		onClose,
		onSubmit,
		onCheckResult
	}: {
		id: string;
		text: string;
		pending?: boolean;
		checkResultId?: string;
		writeBlocked?: boolean;
		errorMessage?: string;
		onTextChange: (text: string) => void;
		onClose: (restoreFocus: boolean) => void;
		onSubmit: () => Promise<void>;
		onCheckResult?: (operationId: string) => Promise<void>;
	} = $props();
</script>

<div use:composerBoundary={onClose} data-discussion-reply>
	<MessageComposer
		{id}
		{text}
		{pending}
		{checkResultId}
		{writeBlocked}
		{errorMessage}
		title="Write a reply"
		placeholder="Reply…"
		submitLabel="Reply"
		{onTextChange}
		{onSubmit}
		{onCheckResult}
	/>
</div>
