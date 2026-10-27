<script lang="ts">
	import type { Snippet } from 'svelte';
	import SettingsCard from './SettingsCard.svelte';

	type Props = {
		title: string;
		description: string[];
		footerText: string;
		ariaLabel: string;
		preview: Snippet;
		uploading?: boolean;
		errorText?: string | null;
		onFileSelected: (file: File) => void | Promise<void>;
	};

	let {
		title,
		description,
		footerText,
		ariaLabel,
		preview,
		uploading = false,
		errorText = null,
		onFileSelected
	}: Props = $props();

	let inputElement = $state<HTMLInputElement | null>(null);

	function chooseFile() {
		if (uploading) {
			return;
		}

		inputElement?.click();
	}

	async function handleFileChange(event: Event) {
		const input = event.currentTarget;

		if (!(input instanceof HTMLInputElement)) {
			return;
		}

		const file = input.files?.[0];
		input.value = '';

		if (!file) {
			return;
		}

		await onFileSelected(file);
	}
</script>

<SettingsCard {title} {description}>
	<div class="mt-4">
		<input
			bind:this={inputElement}
			type="file"
			accept="image/*"
			class="sr-only"
			onchange={handleFileChange}
		/>
		<p class="min-h-5 text-[0.72rem] leading-5 {errorText ? 'text-danger' : 'text-ink-muted'}">
			{errorText ?? (uploading ? 'Uploading...' : '')}
		</p>
	</div>

	{#snippet media()}
		<button
			type="button"
			disabled={uploading}
			class="inline-flex size-[68px] shrink-0 items-center justify-center rounded-full outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
			aria-label={ariaLabel}
			onclick={chooseFile}
		>
			{@render preview()}
		</button>
	{/snippet}

	{#snippet footer()}
		<p>{footerText}</p>
	{/snippet}
</SettingsCard>
