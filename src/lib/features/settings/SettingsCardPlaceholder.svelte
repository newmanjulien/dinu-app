<script lang="ts">
	import SettingsCard from './SettingsCard.svelte';
	import Button from '$lib/ui/Button.svelte';
	import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	let {
		card,
		value,
		profile
	}: {
		value?: string;
		profile?: { name: string; avatarUrl: string | null };
		card: {
			title: string;
			description: string;
			footerText: string;
			kind: 'text' | 'readonly' | 'avatar' | 'danger';
			warning?: string;
			actionLabel?: string;
		};
	} = $props();
</script>

<div aria-busy="true" class="contents">
	{#snippet avatar()}
		<div class="inline-flex size-[68px] shrink-0 items-center justify-center rounded-full">
			{#if profile}<Avatar
					name={profile.name}
					avatarUrl={profile.avatarUrl}
					fallbackUrl={null}
					class="size-17"
				/>
			{:else}<SkeletonBlock class="size-17 rounded-full" />{/if}
		</div>
	{/snippet}

	{#snippet action()}<Button
			disabled
			class={card.kind === 'danger' ? 'bg-danger text-white' : undefined}
		>
			{card.actionLabel ?? (card.kind === 'danger' ? card.title : 'Save')}
		</Button>{/snippet}
	<SettingsCard
		title={card.title}
		description={card.description}
		action={value !== undefined || profile || card.kind === 'readonly' || card.kind === 'avatar'
			? undefined
			: action}
		media={card.kind === 'avatar' ? avatar : undefined}
	>
		{#if value !== undefined}
			<p class="mt-4 min-h-9 max-w-sm break-words text-sm text-ink">{value || 'Not set'}</p>
		{:else if card.warning}
			<div
				class="mt-4 flex min-h-9 items-center gap-2 rounded-button-lg bg-canvas px-3 text-[0.74rem] leading-5 text-ink-muted"
			>
				<InfoIcon weight="regular" aria-hidden="true" class="size-[15px] shrink-0 text-ink-muted" />
				<p>{card.warning}</p>
			</div>
		{:else if card.kind === 'text' || card.kind === 'readonly'}
			<div class="mt-4 max-w-sm space-y-2">
				<SkeletonBlock
					class="h-9 w-full rounded-button-lg border-hairline border-edge shadow-control"
				/>
			</div>
		{/if}
		{#snippet footer()}<p>{card.footerText}</p>{/snippet}
	</SettingsCard>
</div>
