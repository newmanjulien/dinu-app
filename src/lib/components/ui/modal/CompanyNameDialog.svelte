<script lang="ts">
	import TextInput from '$lib/ui/TextInput.svelte';
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
		onExistingSubmit,
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
		onExistingSubmit?: () => void;
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
		if (onExistingSubmit) {
			validation = null;
			onExistingSubmit();
			return;
		}
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
		<TextInput
			bind:element={input}
			id={`${formId}-name`}
			bind:value={name}
			oninput={() => (validation = null)}
			disabled={busy || lockName}
			maxlength={200}
			autocomplete="organization"
			aria-invalid={Boolean(validation || error)}
			aria-describedby={validation || error ? `${formId}-error` : undefined}
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
