<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Role } from '../../../convex/permissions';
	import {
		settingsFields as fields,
		type SettingsField
	} from '$lib/features/settings/settings-fields';
	import SettingsCardPlaceholder from '$lib/features/settings/SettingsCardPlaceholder.svelte';
	let {
		role,
		editCompanyProfile = role === 'admin',
		field
	}: { role?: Role; editCompanyProfile?: boolean; field?: Snippet<[SettingsField]> } = $props();
	const cards = $derived([
		fields.name,
		fields.email,
		...(editCompanyProfile ? [fields.companyName, fields.approvalEmail] : []),
		...(role
			? [
					fields.role,
					fields.avatar,
					...(editCompanyProfile ? [fields.companyAvatar] : []),
					fields.danger
				]
			: [])
	]);
</script>

<section
	class="flex min-h-[calc(100dvh-var(--app-header-height))] w-full bg-page pt-8 pb-12 md:pt-10 md:pb-16"
	aria-busy={!field}
>
	<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 md:gap-7">
		<h1 class="text-lg font-medium">Settings</h1>
		{#each cards as card (card.id)}
			{#if field}{@render field(card)}{:else}<SettingsCardPlaceholder {card} />{/if}
		{/each}
	</div>
</section>
