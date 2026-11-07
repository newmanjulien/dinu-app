<script lang="ts">
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

<SettingsCard title="Delete account" description="Permanently remove your account">
	<div
		class="mt-4 flex min-h-9 items-center gap-2 rounded-button-lg bg-canvas px-3 text-[0.74rem] leading-5 text-ink-muted"
	>
		<InfoIcon weight="regular" class="size-[15px] shrink-0 text-ink-muted" />
		<p>
			If you are the last member, deleting your account also deletes your company and all its data.
		</p>
	</div>

	{#snippet footer()}
		<p>This action is not reversible</p>
	{/snippet}

	{#snippet action()}
		<Button
			class="bg-danger text-white not-disabled:not-aria-disabled:hover:bg-danger-hover"
			onclick={openDeleteModal}>Delete account</Button
		>
	{/snippet}
</SettingsCard>

<DeleteAccountModal open={modalOpen} onClose={closeDeleteModal} />
