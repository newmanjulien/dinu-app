<script lang="ts">
	import TextArea from '$lib/ui/TextArea.svelte';
	import Button from '$lib/ui/Button.svelte';
	import { composerTextarea } from './composer-textarea.svelte';
	import { DISCUSSION_TEXT_LIMIT, validDiscussionText } from './limits';

	let {
		id,
		text,
		pending = false,
		errorMessage = '',
		onTextChange,
		onCancel,
		onSubmit
	}: {
		id: string;
		text: string;
		pending?: boolean;
		errorMessage?: string;
		onTextChange: (text: string) => void;
		onCancel: (restoreFocus: boolean) => void;
		onSubmit: () => void;
	} = $props();

	let rootElement = $state<HTMLDivElement>();
	const errorId = $props.id();
	const textareaAttachment = composerTextarea(() => text);
	let canSubmit = $derived(validDiscussionText(text));

	function handleFocusOut(event: FocusEvent) {
		if (!pending && !rootElement?.contains(event.relatedTarget as Node | null)) onCancel(false);
	}

	function handleInput(event: Event & { currentTarget: HTMLTextAreaElement }) {
		onTextChange(event.currentTarget.value);
	}

	function handleEscape(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onCancel(true);
			return true;
		}
		return false;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (handleEscape(event)) return;

		const shouldSubmit = event.key === 'Enter' && !event.shiftKey && !event.isComposing;

		if (shouldSubmit) {
			event.preventDefault();
			if (canSubmit && !pending) onSubmit();
		}
	}
</script>

<div bind:this={rootElement} data-discussion-reply onfocusout={handleFocusOut}>
	<TextArea
		attachment={textareaAttachment}
		{id}
		class="min-h-0 resize-none overflow-y-hidden"
		rows={1}
		value={text}
		maxlength={DISCUSSION_TEXT_LIMIT}
		placeholder="Reply…"
		aria-label="Write a reply"
		aria-describedby={errorMessage ? errorId : undefined}
		disabled={pending}
		oninput={handleInput}
		onkeydown={handleKeydown}
	/>
	{#if errorMessage}
		<p class="mt-2 mb-0 text-xs leading-[1.35] text-danger" id={errorId} role="alert">
			{errorMessage}
		</p>
	{/if}
	<div class="mt-3 flex justify-end">
		<Button
			variant="secondary"
			disabled={pending || !canSubmit}
			onkeydown={handleEscape}
			onclick={onSubmit}>Reply</Button
		>
	</div>
</div>
