<script lang="ts">
	import { Button } from '$lib/ui';
	import SettingsCard from './SettingsCard.svelte';

	type Props = {
		title: string;
		description: string;
		value: string;
		fieldId: string;
		label: string;
		footerText: string;
		saving?: boolean;
		errorText?: string | null;
		onSave: (value: string) => void | Promise<void>;
	};

	let {
		title,
		description,
		value,
		fieldId,
		label,
		footerText,
		saving = false,
		errorText = null,
		onSave
	}: Props = $props();

	const maxLength = 32;
	let draftValue = $state('');
	let localErrorText = $state<string | null>(null);
	let hideServerError = $state(false);
	let syncedValue = $state<string | null>(null);

	const trimmedDraftValue = $derived(draftValue.trim());
	const trimmedValue = $derived(value.trim());
	const validationErrorText = $derived.by(() => {
		if (!trimmedDraftValue) {
			return `${label} is required.`;
		}

		if (trimmedDraftValue.length > maxLength) {
			return `${label} must be ${maxLength} characters or fewer.`;
		}

		return null;
	});
	const changed = $derived(trimmedDraftValue !== trimmedValue);
	const visibleValidationErrorText = $derived(changed ? validationErrorText : null);
	const serverErrorText = $derived(hideServerError ? null : errorText);
	const shownErrorText = $derived(localErrorText ?? serverErrorText ?? visibleValidationErrorText);
	const canSave = $derived(changed && !validationErrorText && !saving);

	$effect(() => {
		if (syncedValue !== value) {
			draftValue = value;
			syncedValue = value;
			localErrorText = null;
			hideServerError = false;
		}
	});

	async function handleSave() {
		localErrorText = validationErrorText;
		hideServerError = false;

		if (!canSave) {
			return;
		}

		await onSave(trimmedDraftValue);
	}
</script>

<SettingsCard {title} {description}>
	<div class="mt-4 max-w-sm space-y-2">
		<label class="sr-only" for={fieldId}>{label}</label>
		<input
			id={fieldId}
			type="text"
			bind:value={draftValue}
			maxlength={maxLength}
			aria-invalid={Boolean(shownErrorText)}
			aria-describedby={`${fieldId}-message`}
			oninput={() => {
				localErrorText = null;
				hideServerError = true;
			}}
			class="w-full rounded-button-lg border-hairline border-edge bg-surface px-3 shadow-control outline-none transition-[background-color] focus-within:border-accent focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/18 not-disabled:not-aria-disabled:[&:not([readonly])]:not-aria-invalid:hover:not-focus-within:bg-field-hover not-disabled:not-aria-disabled:aria-invalid:border-danger/30 not-disabled:not-aria-disabled:aria-invalid:bg-danger-surface not-disabled:not-aria-disabled:aria-invalid:text-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:border-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:outline-danger/18 motion-reduce:transition-none min-w-0 text-[13px] placeholder:font-[350] placeholder:text-ink-muted text-ink disabled:bg-canvas disabled:text-ink-muted [&[readonly]]:bg-canvas [&[readonly]]:text-ink-muted h-9"
		/>
		<p
			id={`${fieldId}-message`}
			class="min-h-5 text-[0.72rem] leading-5 {shownErrorText ? 'text-danger' : 'text-ink-muted'}"
		>
			{shownErrorText ?? ''}
		</p>
	</div>

	{#snippet footer()}
		<p>{footerText}</p>
	{/snippet}

	{#snippet action()}
		<Button disabled={!canSave} onclick={handleSave}>{saving ? 'Saving...' : 'Save'}</Button>
	{/snippet}
</SettingsCard>
