<script lang="ts">
	import TextArea from '$lib/ui/TextArea.svelte';
	import { multilineSubmitShortcut } from '$lib/ui/multiline-submit-shortcut';
	import { Button, ModalShell } from '$lib/ui';

	type Props = {
		error: string | null;
		isAdding: boolean;
		open: boolean;
		value: string;
		onClose: () => void;
		onSubmit: () => void | Promise<void>;
		onValueChange: (value: string) => void;
	};

	let { error, isAdding, open, value, onClose, onSubmit, onValueChange }: Props = $props();
	const shortcut = multilineSubmitShortcut(() => {
		if (!isAdding) void onSubmit();
	});
</script>

<ModalShell {open} title="Invite" dismissible={!isAdding} {onClose}>
	<label for="team-member-emails" class="block text-xs text-ink"
		>List colleague emails separated by commas</label
	>
	<TextArea
		id="team-member-emails"
		{value}
		disabled={isAdding}
		aria-invalid={Boolean(error)}
		aria-describedby={error ? 'team-member-emails-error' : undefined}
		placeholder="alex@example.com, sam@example.com, jordan@example.com"
		class="mt-2 min-h-44 py-3"
		oninput={(event) => {
			if (!isAdding) onValueChange(event.currentTarget.value);
		}}
		onkeydown={shortcut.keydown}
		oncompositionstart={shortcut.compositionStart}
		oncompositionend={shortcut.compositionEnd}
	/>
	{#if error}
		<p id="team-member-emails-error" class="mt-2 text-[0.72rem] text-danger">{error}</p>
	{/if}

	{#snippet footer()}
		<Button variant="secondary" disabled={isAdding} onclick={onClose}>Cancel</Button>
		<Button disabled={isAdding} onclick={() => void onSubmit()}>
			{isAdding ? 'Sending...' : 'Invite'}
		</Button>
	{/snippet}
</ModalShell>
