<script lang="ts">
	import { settingsFields } from './settings-fields';
	import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
	import { Button } from '$lib/ui';
	import DeleteAccountModal from './DeleteAccountModal.svelte';
	import SettingsCard from './SettingsCard.svelte';

	let modalOpen = $state(false);

	function openDeleteModal() {
		modalOpen = true;
	}

	function closeDeleteModal() {
		modalOpen = false;
	}
</script>

<SettingsCard title={settingsFields.danger.title} description={settingsFields.danger.description}>
	<div
		class="mt-4 flex min-h-9 items-center gap-2 rounded-button-lg bg-canvas px-3 text-[0.74rem] leading-5 text-ink-muted"
	>
		<InfoIcon weight="regular" class="size-[15px] shrink-0 text-ink-muted" />
		<p>{settingsFields.danger.warning}</p>
	</div>

	{#snippet footer()}
		<p>{settingsFields.danger.footerText}</p>
	{/snippet}

	{#snippet action()}
		<Button
			class="bg-danger text-white not-disabled:not-aria-disabled:hover:bg-danger-hover"
			onclick={openDeleteModal}>Delete account</Button
		>
	{/snippet}
</SettingsCard>

<DeleteAccountModal open={modalOpen} onClose={closeDeleteModal} />
