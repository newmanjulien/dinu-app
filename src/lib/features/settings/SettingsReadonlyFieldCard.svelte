<script lang="ts">
	import { fieldClass } from '$lib/ui/field-styles';
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
		<input id={fieldId} type="text" readonly {value} class={`${fieldClass} h-9`} />
	</div>

	{#snippet footer()}
		<p>{footerText}</p>
	{/snippet}
</SettingsCard>
