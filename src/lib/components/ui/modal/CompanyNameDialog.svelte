<script lang="ts">
	import { untrack } from 'svelte';
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import Button from '$lib/ui/Button.svelte';
	let {
		title,
		nameLabel = 'Buyer company name',
		initialName = '',
		submitLabel = 'Save contract',
		busyLabel = 'Saving…',
		lockName = false,
		open = true,
		busy = false,
		submitDisabled = false,
		error = null,
		onRetry,
		onSubmit,
		onClose,
		onOpen
	}: {
		title: string;
		nameLabel?: string;
		initialName?: string;
		submitLabel?: string;
		busyLabel?: string;
		lockName?: boolean;
		open?: boolean;
		busy?: boolean;
		submitDisabled?: boolean;
		error?: string | null;
		onRetry?: () => void;
		onSubmit: (name: string) => void;
		onClose: () => void;
		onOpen?: () => void;
	} = $props();
	const formId = $props.id();
	let name = $state(untrack(() => initialName));
	let validation = $state<string | null>(null);
	let input = $state<HTMLInputElement>();
	let initialized = false;
	function focusName() {
		input?.focus({ preventScroll: true });
		if (!initialized) {
			input?.select();
			initialized = true;
		}
	}
	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy || submitDisabled || !open) return;
		if (!name.trim()) {
			validation = 'Enter a buyer company name.';
			input?.focus();
			return;
		}
		validation = null;
		onSubmit(name.trim());
	}
</script>

<ModalShell
	{open}
	{title}
	{onClose}
	class="max-w-[420px]"
	dismissible={!busy}
	showCloseButton={false}
	closeOnBackdrop={false}
	onOpen={() => {
		focusName();
		onOpen?.();
	}}
>
	<form id={formId} onsubmit={submit}>
		<label class="mb-2 block text-sm" for={`${formId}-name`}>{nameLabel}</label>
		<input
			bind:this={input}
			id={`${formId}-name`}
			bind:value={name}
			oninput={() => (validation = null)}
			disabled={busy || lockName}
			maxlength={200}
			autocomplete="organization"
			aria-invalid={Boolean(validation || error)}
			aria-describedby={validation || error ? `${formId}-error` : undefined}
			class="w-full rounded-button-lg border-hairline border-edge bg-surface px-3 shadow-control outline-none transition-[background-color] focus-within:border-accent focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/18 not-disabled:not-aria-disabled:[&:not([readonly])]:not-aria-invalid:hover:not-focus-within:bg-field-hover not-disabled:not-aria-disabled:aria-invalid:border-danger/30 not-disabled:not-aria-disabled:aria-invalid:bg-danger-surface not-disabled:not-aria-disabled:aria-invalid:text-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:border-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:outline-danger/18 motion-reduce:transition-none min-w-0 text-[13px] placeholder:font-[350] placeholder:text-ink-muted text-ink disabled:bg-canvas disabled:text-ink-muted [&[readonly]]:bg-canvas [&[readonly]]:text-ink-muted h-9"
		/>
		{#if validation || error}<p
				id={`${formId}-error`}
				role="alert"
				class="mt-3 text-sm text-danger"
			>
				{validation || error}
				{#if error && onRetry}<button type="button" class="ml-1 underline" onclick={onRetry}
						>Try again</button
					>{/if}
			</p>{/if}
	</form>
	{#snippet footer()}
		<div class="ml-auto flex justify-end gap-2">
			<Button variant="secondary" disabled={busy} onclick={onClose}>Cancel</Button>
			<Button type="submit" form={formId} disabled={busy || submitDisabled}
				>{busy ? busyLabel : submitLabel}</Button
			>
		</div>
	{/snippet}
</ModalShell>
