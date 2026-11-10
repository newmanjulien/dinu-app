<script lang="ts">
	import { focusComposer } from './focus-composer';
	import MessageByline from './MessageByline.svelte';
	import { autosizeTextarea } from './textarea-autosize';

	let {
		text,
		title,
		placeholder,
		submitLabel,
		cancelLabel,
		submitOnEnter = false,
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
		pending?: boolean;
		errorMessage?: string;
		onTextChange: (text: string) => void;
		onCancel?: () => void;
		onSubmit: () => void;
	} = $props();

	let canSubmit = $derived(Boolean(text.trim()));

	function handleInput(event: Event & { currentTarget: HTMLTextAreaElement }) {
		onTextChange(event.currentTarget.value);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && onCancel) {
			event.preventDefault();
			event.stopPropagation();
			onCancel();
			return;
		}

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
<textarea
	use:focusComposer
	class="block min-h-10 w-full resize-none appearance-none overflow-y-hidden rounded-input border border-line/[58%] bg-surface px-3 py-2 text-[15px] leading-[1.45] text-ink shadow-none placeholder:text-ink-muted focus:border-accent focus:outline-2 focus:outline-offset-1 focus:outline-accent/18"
	rows="1"
	value={text}
	use:autosizeTextarea={{ value: text, maxHeight: 160 }}
	{placeholder}
	aria-label={title}
	disabled={pending}
	oninput={handleInput}
	onkeydown={handleKeydown}></textarea>
{#if errorMessage}
	<p class="mt-2 mb-0 text-xs leading-[1.35] text-ink-secondary" role="alert">{errorMessage}</p>
{/if}
<div class="mt-3 flex justify-end gap-2">
	{#if cancelLabel && onCancel}
		<button
			class="h-10 cursor-pointer rounded-button-lg border border-transparent bg-transparent px-3.5 text-[15px] font-medium text-ink-muted hover:bg-surface-hover hover:text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-default disabled:text-ink-muted"
			type="button"
			disabled={pending}
			onclick={onCancel}
		>
			{cancelLabel}
		</button>
	{/if}
	<button
		class="h-10 cursor-pointer rounded-button-lg border border-line bg-surface px-3.5 text-[15px] font-medium text-ink-secondary hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-default disabled:bg-surface disabled:text-ink-muted"
		type="button"
		disabled={pending || !canSubmit}
		onclick={onSubmit}
	>
		{submitLabel}
	</button>
</div>
