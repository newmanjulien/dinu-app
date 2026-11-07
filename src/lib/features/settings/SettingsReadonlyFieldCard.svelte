<script lang="ts">
	import SettingsCard from './SettingsCard.svelte';

	type Props = {
		title: string;
		description: string;
		value: string;
		fieldId: string;
		label: string;
		footerText: string;
	};

	let { title, description, value, fieldId, label, footerText }: Props = $props();
</script>

<SettingsCard {title} {description}>
	<div class="mt-4 max-w-sm space-y-2">
		<label class="sr-only" for={fieldId}>{label}</label>
		<input
			id={fieldId}
			type="text"
			readonly
			{value}
			class="w-full rounded-button-lg border-hairline border-edge bg-surface px-3 shadow-control outline-none transition-[background-color] focus-within:border-accent focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/18 not-disabled:not-aria-disabled:[&:not([readonly])]:not-aria-invalid:hover:not-focus-within:bg-field-hover not-disabled:not-aria-disabled:aria-invalid:border-danger/30 not-disabled:not-aria-disabled:aria-invalid:bg-danger-surface not-disabled:not-aria-disabled:aria-invalid:text-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:border-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:outline-danger/18 motion-reduce:transition-none min-w-0 text-[13px] placeholder:font-[350] placeholder:text-ink-muted text-ink disabled:bg-canvas disabled:text-ink-muted [&[readonly]]:bg-canvas [&[readonly]]:text-ink-muted h-9"
		/>
	</div>

	{#snippet footer()}
		<p>{footerText}</p>
	{/snippet}
</SettingsCard>
