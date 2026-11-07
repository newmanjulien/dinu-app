<script lang="ts">
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

<ModalShell {open} title="Invite" dismissible={!isAdding} {onClose}>
	<label for="team-member-emails" class="block text-xs text-ink"
		>List colleague emails separated by commas</label
	>
	<textarea
		id="team-member-emails"
		{value}
		disabled={isAdding}
		placeholder="alex@example.com, sam@example.com, jordan@example.com"
		class="w-full rounded-button-lg border-hairline border-edge bg-surface px-3 shadow-control outline-none transition-[background-color] focus-within:border-accent focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/18 not-disabled:not-aria-disabled:[&:not([readonly])]:not-aria-invalid:hover:not-focus-within:bg-field-hover not-disabled:not-aria-disabled:aria-invalid:border-danger/30 not-disabled:not-aria-disabled:aria-invalid:bg-danger-surface not-disabled:not-aria-disabled:aria-invalid:text-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:border-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:outline-danger/18 motion-reduce:transition-none min-w-0 text-[13px] placeholder:font-[350] placeholder:text-ink-muted text-ink disabled:bg-canvas disabled:text-ink-muted [&[readonly]]:bg-canvas [&[readonly]]:text-ink-muted mt-2 min-h-44 resize-y py-3 leading-[1.45]"
		oninput={(event) => {
			if (!isAdding) onValueChange(event.currentTarget.value);
		}}></textarea>
	{#if error}
		<p class="mt-2 text-[0.72rem] text-danger">{error}</p>
	{/if}

	{#snippet footer()}
		<Button variant="secondary" disabled={isAdding} onclick={onClose}>Cancel</Button>
		<Button disabled={isAdding} onclick={() => void onSubmit()}>
			{isAdding ? 'Sending...' : 'Invite'}
		</Button>
	{/snippet}
</ModalShell>
