<script lang="ts">
	import TextArea from '$lib/ui/TextArea.svelte';
	import Button from '$lib/ui/Button.svelte';
	import { multilineSubmitShortcut } from '$lib/ui/multiline-submit-shortcut';
	import { composerTextarea } from './composer-textarea.svelte';
	import { DISCUSSION_TEXT_LIMIT, validDiscussionText } from './limits';
	import MessageByline from './MessageByline.svelte';

	let {
		id,
		text,
		title,
		placeholder,
		submitLabel,
		closeLabel,
		pending = false,
		writeBlocked = false,
		textLocked = false,
		errorMessage = '',
		onTextChange,
		onClose,
		onSubmit,
		author,
		viewerKey,
		perspective = 'buyer'
	}: {
		author?: import('./session.svelte').DiscussionAuthor;
		viewerKey?: string;
		perspective?: 'buyer' | 'seller';
		id?: string;
		text: string;
		title: string;
		placeholder: string;
		submitLabel: string;
		closeLabel?: string;
		pending?: boolean;
		writeBlocked?: boolean;
		textLocked?: boolean;
		errorMessage?: string;
		onTextChange: (text: string) => void;
		onClose?: () => void;
		onSubmit: () => Promise<void>;
	} = $props();

	const errorId = $props.id();
	const textareaAttachment = composerTextarea(() => text);
	let submitting = $state(false);
	let canSubmit = $derived(!writeBlocked && validDiscussionText(text));

	async function submit() {
		if (pending || submitting || !canSubmit) return;
		submitting = true;
		try {
			await onSubmit();
		} finally {
			submitting = false;
		}
	}
	const shortcut = multilineSubmitShortcut(() => void submit());

	function handleInput(event: Event & { currentTarget: HTMLTextAreaElement }) {
		onTextChange(event.currentTarget.value);
	}
</script>

{#if author}<div class="mb-2.5">
		<MessageByline {author} {viewerKey} {perspective} />
	</div>{/if}
<TextArea
	attachment={textareaAttachment}
	{id}
	class="min-h-0 resize-none overflow-y-hidden"
	rows={1}
	value={text}
	maxlength={DISCUSSION_TEXT_LIMIT}
	{placeholder}
	aria-label={title}
	aria-describedby={errorMessage ? errorId : undefined}
		disabled={pending || writeBlocked || textLocked}
	oninput={handleInput}
	onkeydown={shortcut.keydown}
	oncompositionstart={shortcut.compositionStart}
	oncompositionend={shortcut.compositionEnd}
/>
{#if errorMessage}
	<p class="mt-2 mb-0 text-xs leading-[1.35] text-danger" id={errorId} role="alert">
		{errorMessage}
	</p>
{/if}
<div class="mt-3 flex flex-wrap justify-end gap-3">
	{#if closeLabel && onClose}
			<Button variant="secondary" disabled={textLocked} onclick={onClose}>
			{closeLabel}
		</Button>
	{/if}
	<Button
		variant="secondary"
		disabled={pending || submitting || !canSubmit}
		onclick={() => void submit()}
	>
		{submitLabel}
	</Button>
</div>
