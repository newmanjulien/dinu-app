<script lang="ts">
	import { fieldClass } from '$lib/ui/field-styles';
	import { Button } from '$lib/ui';
	import SettingsCard from './SettingsCard.svelte';

	type Props = {
		title: string;
		description: string;
		value: string;
		fieldId: string;
		label: string;
		footerText: string;
		maxLength?: number;
		saving?: boolean;
		errorText?: string | null;
		actionLabel?: string;
		onSave: (value: string) => void | Promise<void>;
	};

	let {
		title,
		description,
		value,
		fieldId,
		label,
		footerText,
		maxLength = 32,
		saving = false,
		errorText = null,
		actionLabel = 'Save',
		onSave
	}: Props = $props();

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
			class={`${fieldClass} h-9`}
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
		<Button disabled={!canSave} onclick={handleSave}>{saving ? 'Saving...' : actionLabel}</Button>
	{/snippet}
</SettingsCard>
