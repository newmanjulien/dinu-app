<script lang="ts">
	import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
	import { Button, destructiveButtonClass } from '$lib/ui';
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
		class="mt-4 flex min-h-9 items-center gap-2 rounded-button-lg bg-stone-100 px-3 text-[0.74rem] leading-5 text-stone-600"
	>
		<InfoIcon size={15} weight="regular" class="shrink-0 text-stone-500" />
		<p>
			If you are the last member, deleting your account also deletes your company and all its data.
			Otherwise, company contracts remain available to your colleagues.
		</p>
	</div>

	{#snippet footer()}
		<p>This action is not reversible</p>
	{/snippet}

	{#snippet action()}
		<Button class={destructiveButtonClass} onclick={openDeleteModal}>Delete account</Button>
	{/snippet}
</SettingsCard>

<DeleteAccountModal open={modalOpen} onClose={closeDeleteModal} />
