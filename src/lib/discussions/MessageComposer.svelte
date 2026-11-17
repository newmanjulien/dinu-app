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
		allowDeletion = false,
		deleting = false,
		pending = false,
		checkResultId,
		writeBlocked = false,
		errorMessage = '',
		onTextChange,
		onDeleteChange,
		onClose,
		onSubmit,
		onCheckResult,
		author,
		viewerKey
	}: {
		author?: import('./session.svelte').DiscussionAuthor;
		viewerKey?: string;
		id?: string;
		text: string;
		title: string;
		placeholder: string;
		submitLabel: string;
		closeLabel?: string;
		allowDeletion?: boolean;
		deleting?: boolean;
		pending?: boolean;
		checkResultId?: string;
		writeBlocked?: boolean;
		errorMessage?: string;
		onTextChange: (text: string) => void;
		onDeleteChange?: (deleting: boolean) => void;
		onClose?: () => void;
		onSubmit: () => Promise<void>;
		onCheckResult?: (operationId: string) => Promise<void>;
	} = $props();

	const errorId = $props.id();
	const textareaAttachment = composerTextarea(() => text);
	let submitting = $state(false);
	let canSubmit = $derived(
		!writeBlocked &&
			(Boolean(checkResultId) ||
				validDiscussionText(text) ||
				(allowDeletion && deleting && text.length === 0))
	);

	async function submit() {
		if (pending || submitting || !canSubmit) return;
		submitting = true;
		try {
			if (checkResultId) await onCheckResult?.(checkResultId);
			else await onSubmit();
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
		<MessageByline {author} {viewerKey} />
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
	disabled={pending || Boolean(checkResultId) || writeBlocked}
	oninput={handleInput}
	onkeydown={shortcut.keydown}
	oncompositionstart={shortcut.compositionStart}
	oncompositionend={shortcut.compositionEnd}
/>
{#if allowDeletion && !text.length}<label
		class="mt-2 flex items-center gap-2 text-xs text-ink-secondary"
		><input
			type="checkbox"
			checked={deleting}
			disabled={pending || Boolean(checkResultId) || writeBlocked}
			onchange={(event) => onDeleteChange?.(event.currentTarget.checked)}
		/>Delete selected wording</label
	>{/if}
{#if errorMessage}
	<p class="mt-2 mb-0 text-xs leading-[1.35] text-danger" id={errorId} role="alert">
		{errorMessage}
	</p>
{/if}
<div class="mt-3 flex flex-wrap justify-end gap-2">
	{#if closeLabel && onClose}
		<Button variant="ghost" onclick={onClose}>
			{closeLabel}
		</Button>
	{/if}
	<Button
		variant="secondary"
		disabled={pending || submitting || !canSubmit}
		onclick={() => void submit()}
	>
		{checkResultId ? 'Check result' : deleting && !text.length ? 'Delete wording' : submitLabel}
	</Button>
</div>
