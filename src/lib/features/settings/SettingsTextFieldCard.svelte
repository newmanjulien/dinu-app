<script lang="ts">
	import TextInput from '$lib/ui/TextInput.svelte';
	import { Button } from '$lib/ui';
	import SettingsCard from './SettingsCard.svelte';
	import { EMAIL_MAX_LENGTH, normalizedEmailAddress } from '$lib/email-address';

	type Props = {
		kind: 'personal-name' | 'company-name' | 'approval-email' | 'contract-name';
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
		kind,
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

	const maxLength = $derived(
		kind === 'approval-email'
			? EMAIL_MAX_LENGTH
			: kind === 'contract-name'
				? 200
				: kind === 'company-name'
					? 120
					: 32
	);
	let draftValue = $derived(value);
	let localErrorText = $state<string | null>(null);
	let hideServerError = $state(false);

	const trimmedDraftValue = $derived(draftValue.trim());
	const trimmedValue = $derived(value.trim());
	const validationErrorText = $derived.by(() => {
		if (!trimmedDraftValue) {
			return `${label} is required.`;
		}

		if (trimmedDraftValue.length > maxLength) {
			return `${label} must be ${maxLength} characters or fewer.`;
		}

		if (kind === 'approval-email' && normalizedEmailAddress(trimmedDraftValue) === null)
			return 'Enter a valid email address.';
		return null;
	});
	const changed = $derived(trimmedDraftValue !== trimmedValue);
	const visibleValidationErrorText = $derived(changed ? validationErrorText : null);
	const serverErrorText = $derived(hideServerError ? null : errorText);
	const shownErrorText = $derived(localErrorText ?? serverErrorText ?? visibleValidationErrorText);
	const canSave = $derived(changed && !validationErrorText && !saving);

	$effect(() => {
		void value;
		localErrorText = null;
		hideServerError = false;
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
		<TextInput
			id={fieldId}
			type="text"
			bind:value={draftValue}
			maxlength={maxLength}
			aria-invalid={Boolean(shownErrorText)}
			aria-describedby={shownErrorText ? `${fieldId}-message` : undefined}
			oninput={() => {
				localErrorText = null;
				hideServerError = true;
			}}
		/>
		{#if shownErrorText}
			<p id={`${fieldId}-message`} class="text-[0.72rem] leading-5 text-danger">
				{shownErrorText}
			</p>
		{/if}
	</div>

	{#snippet footer()}
		<p>{footerText}</p>
	{/snippet}

	{#snippet action()}
		<Button disabled={!canSave} onclick={handleSave}>{saving ? 'Saving...' : 'Save'}</Button>
	{/snippet}
</SettingsCard>
