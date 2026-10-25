<script lang="ts">
	import { untrack } from 'svelte';
	import ModalShell from '$lib/ui/ModalShell.svelte';
	let {
		title,
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
		onClose
	}: {
		title: string;
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
	maxWidth={420}
	dismissible={!busy}
	showCloseButton={false}
	closeOnBackdrop={false}
	onOpen={focusName}
>
	<form id={formId} onsubmit={submit}>
		<label class="mb-2 block text-sm" for={`${formId}-name`}>Buyer company name</label>
		<input
			bind:this={input}
			id={`${formId}-name`}
			bind:value={name}
			oninput={() => (validation = null)}
			disabled={busy || lockName}
			maxlength="200"
			autocomplete="organization"
			aria-invalid={Boolean(validation || error)}
			aria-describedby={validation || error ? `${formId}-error` : undefined}
			class="h-9 w-full rounded-xl border border-[#e5e5e5] bg-white px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-[#8a8a8a] focus:border-[#d5d5d5] disabled:opacity-50"
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
			<button
				type="button"
				disabled={busy}
				onclick={onClose}
				class="h-[38px] rounded-button-lg border border-[#e5e5e5] bg-white px-3.5 py-2 text-[12.5px] font-normal transition-colors hover:bg-[#f3f3f3] focus-visible:outline-1 focus-visible:outline-[#d5d5d5] disabled:opacity-50"
				>Cancel</button
			>
			<button
				type="submit"
				form={formId}
				disabled={busy || submitDisabled}
				class="h-[38px] rounded-button-lg bg-[#171717] px-3.5 py-2 text-[12.5px] font-normal text-white hover:bg-[#303030] focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#d5d5d5] disabled:opacity-50"
				>{busy ? busyLabel : submitLabel}</button
			>
		</div>
	{/snippet}
</ModalShell>
