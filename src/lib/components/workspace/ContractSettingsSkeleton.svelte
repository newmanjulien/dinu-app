<script lang="ts">
	import SettingsCard from '$lib/features/settings/SettingsCard.svelte';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
</script>

<div
	aria-hidden="true"
	class="flex min-h-[calc(100dvh-var(--app-header-height))] w-full bg-page pt-8 md:pt-10"
>
	<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 md:gap-7">
		<div class="flex items-center gap-2 text-[12.5px]">
			<SkeletonBlock class="h-3 w-24" />
			<SkeletonBlock class="size-3" />
			<span class="text-[12.5px]">Contract settings</span>
		</div>
		<div class="text-lg font-medium">Contract settings</div>
		{#each ['Contract name', 'Delete contract'] as title (title)}
			<SettingsCard {title}>
				<SkeletonBlock class="mt-3 w-fit text-[0.74rem] leading-5"
					>{title === 'Contract name'
						? 'This is the buyer company name displayed for this contract.'
						: 'Permanently remove this contract and its saved choices and document snapshot.'}</SkeletonBlock
				>
				{#if title === 'Contract name'}
					<SkeletonBlock class="mt-4 h-9 w-full max-w-sm rounded-button-lg" />
				{/if}
				{#snippet footer()}<SkeletonBlock class="w-fit"
						>{title === 'Contract name'
							? 'Use the company name your team recognizes.'
							: 'This action is not reversible'}</SkeletonBlock
					>{/snippet}
				{#snippet action()}<SkeletonBlock
						class="h-button-sm whitespace-nowrap rounded-button-lg px-[13px] py-[7.5px] text-[12.5px] font-normal"
						>{title === 'Contract name' ? 'Save' : 'Delete contract'}</SkeletonBlock
					>{/snippet}
			</SettingsCard>
		{/each}
	</div>
</div>
