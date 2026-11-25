<script lang="ts">
	import MessageComposer from './MessageComposer.svelte';
	import { composerBoundary } from './focus-composer';

	let {
		id,
		text,
		pending = false,
		writeBlocked = false,
		textLocked = false,
		errorMessage = '',
		onTextChange,
		onClose,
		onSubmit
	}: {
		id: string;
		text: string;
		pending?: boolean;
		writeBlocked?: boolean;
		textLocked?: boolean;
		errorMessage?: string;
		onTextChange: (text: string) => void;
		onClose: (restoreFocus: boolean) => void;
		onSubmit: () => Promise<void>;
	} = $props();
</script>

<div use:composerBoundary={onClose} data-discussion-reply>
	<MessageComposer
		{id}
		{text}
		{pending}
		{writeBlocked}
		{textLocked}
		{errorMessage}
		title="Write a reply"
		placeholder="Reply…"
		submitLabel={textLocked ? 'Retry' : 'Reply'}
		{onTextChange}
		{onSubmit}
	/>
</div>
