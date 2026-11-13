<script lang="ts">
	import TextArea from '$lib/ui/TextArea.svelte';
	import Button from '$lib/ui/Button.svelte';
	import { composerTextarea } from './composer-textarea.svelte';
	import { DISCUSSION_TEXT_LIMIT, validDiscussionText } from './limits';
	import MessageByline from './MessageByline.svelte';

	let {
		text,
		title,
		placeholder,
		submitLabel,
		cancelLabel,
		submitOnEnter = false,
		allowDeletion = false,
		pending = false,
		errorMessage = '',
		onTextChange,
		onCancel,
		onSubmit,
		author,
		viewerKey
	}: {
		author?: import('./session.svelte').DiscussionAuthor;
		viewerKey?: string;
		text: string;
		title: string;
		placeholder: string;
		submitLabel: string;
		cancelLabel?: string;
		submitOnEnter?: boolean;
		allowDeletion?: boolean;
		pending?: boolean;
		errorMessage?: string;
		onTextChange: (text: string) => void;
		onCancel?: () => void;
		onSubmit: () => void;
	} = $props();

	const errorId = $props.id();
	const textareaAttachment = composerTextarea(() => text);
	let deleting = $state(false);
	let canSubmit = $derived(
		validDiscussionText(text) || (allowDeletion && deleting && text.length === 0)
	);

	function handleInput(event: Event & { currentTarget: HTMLTextAreaElement }) {
		onTextChange(event.currentTarget.value);
	}

	function handleEscape(event: KeyboardEvent) {
		if (event.key === 'Escape' && onCancel) {
			event.preventDefault();
			event.stopPropagation();
			onCancel();
			return true;
		}
		return false;
	}
	function handleKeydown(event: KeyboardEvent) {
		if (handleEscape(event)) return;

		const shouldSubmit =
			event.key === 'Enter' &&
			!event.isComposing &&
			(submitOnEnter ? !event.shiftKey : event.metaKey || event.ctrlKey);

		if (shouldSubmit) {
			event.preventDefault();
			if (canSubmit && !pending) onSubmit();
		}
	}
</script>

<div class="mb-2.5">
	<MessageByline {author} {viewerKey} />
</div>
<TextArea
	attachment={textareaAttachment}
	class="min-h-0 resize-none overflow-y-hidden"
	rows={1}
	value={text}
	maxlength={DISCUSSION_TEXT_LIMIT}
	{placeholder}
	aria-label={title}
	aria-describedby={errorMessage ? errorId : undefined}
	disabled={pending}
	oninput={handleInput}
	onkeydown={handleKeydown}
/>
{#if allowDeletion && !text.length}<label
		class="mt-2 flex items-center gap-2 text-xs text-ink-secondary"
		><input type="checkbox" bind:checked={deleting} disabled={pending} />Delete selected wording</label
	>{/if}
{#if errorMessage}
	<p class="mt-2 mb-0 text-xs leading-[1.35] text-danger" id={errorId} role="alert">
		{errorMessage}
	</p>
{/if}
<div class="mt-3 flex justify-end gap-2">
	{#if cancelLabel && onCancel}
		<Button variant="ghost" disabled={pending} onkeydown={handleEscape} onclick={onCancel}>
			{cancelLabel}
		</Button>
	{/if}
	<Button
		variant="secondary"
		disabled={pending || !canSubmit}
		onkeydown={handleEscape}
		onclick={onSubmit}
	>
		{deleting && !text.length ? 'Delete wording' : submitLabel}
	</Button>
</div>
