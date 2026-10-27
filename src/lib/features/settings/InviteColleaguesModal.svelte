<script lang="ts">
	import { fieldClass } from '$lib/ui/field-styles';
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
</script>

<ModalShell {open} title="Invite colleagues" dismissible={!isAdding} {onClose}>
	<label for="team-member-emails" class="block text-xs text-ink"
		>List colleague emails separated by commas</label
	>
	<textarea
		id="team-member-emails"
		{value}
		disabled={isAdding}
		placeholder="alex@example.com, sam@example.com, jordan@example.com"
		class={`${fieldClass} mt-2 min-h-44 resize-y py-3 leading-[1.45]`}
		oninput={(event) => {
			if (!isAdding) onValueChange(event.currentTarget.value);
		}}></textarea>
	{#if error}
		<p class="mt-2 text-[0.72rem] text-danger">{error}</p>
	{/if}

	{#snippet footer()}
		<Button variant="secondary" disabled={isAdding} onclick={onClose}>Cancel</Button>
		<Button disabled={isAdding} onclick={() => void onSubmit()}>
			{isAdding ? 'Sending...' : 'Invite colleagues'}
		</Button>
	{/snippet}
</ModalShell>
