<script lang="ts">
	import type { Role } from '../../../convex/permissions';
	import SettingsCard from '$lib/features/settings/SettingsCard.svelte';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	let { role }: { role?: Role } = $props();
	const cards = $derived([
		{
			title: 'Your name',
			kind: 'text',
			description: 'This is your visible name in Dinu.',
			footer: "We display your email if you don't provide a name."
		},
		{
			title: 'Sign-in email',
			kind: 'readonly',
			description: 'This is the email address you use to sign in to Dinu.',
			footer: 'You cannot change this email.'
		},
		...(role === 'admin'
			? [
					{
						title: 'Company name',
						kind: 'text',
						description: "This is your company's visible name in Dinu.",
						footer: 'Use the company or department name your team recognizes.'
					},
					{
						title: 'Approval email',
						kind: 'text',
						description: 'Contract approval requests are sent to this address.',
						footer: "Defaults to the company creator's email. You can change the recipient here."
					}
				]
			: []),
		...(role
			? [
					{
						title: 'Your role',
						kind: 'text',
						description:
							'Choose Rep or Admin for yourself. Admins can manage company settings and colleagues.',
						footer: 'You can change your role at any time.'
					},
					{
						title: 'Your avatar',
						kind: 'avatar',
						description: 'This is your personal avatar.',
						footer: 'An avatar is optional but helps team members recognize you.'
					},
					...(role === 'admin'
						? [
								{
									title: 'Company avatar',
									kind: 'avatar',
									description: "This is your company's avatar.",
									footer: 'An avatar is optional.'
								}
							]
						: []),
					{
						title: 'Delete account',
						kind: 'danger',
						description: 'Permanently remove your account',
						footer: 'This action is not reversible'
					}
				]
			: [])
	]);
</script>

<div
	class="flex min-h-[calc(100dvh-var(--app-header-height))] w-full bg-page pt-8 md:pt-10"
	aria-hidden="true"
>
	<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 md:gap-7">
		<div class="text-lg font-medium">Settings</div>
		{#snippet avatar()}<SkeletonBlock class="size-17 rounded-full" />{/snippet}
		{#each cards as card (card.title)}
			{#snippet action()}<SkeletonBlock
					class="h-button-sm whitespace-nowrap rounded-button-lg px-[13px] py-[7.5px] text-[12.5px] font-normal"
					>{card.kind === 'danger' ? 'Delete account' : 'Save'}</SkeletonBlock
				>{/snippet}
			<SettingsCard
				title={card.title}
				action={card.kind === 'readonly' || card.kind === 'avatar' ? undefined : action}
				media={card.kind === 'avatar' ? avatar : undefined}
			>
				<SkeletonBlock class="mt-3 w-fit text-[0.74rem] leading-5">{card.description}</SkeletonBlock
				>
				{#if card.kind === 'danger'}
					<div
						class="mt-4 flex min-h-9 items-center gap-2 rounded-button-lg px-3 text-[0.74rem] leading-5"
					>
						<SkeletonBlock class="size-[15px] shrink-0" />
						<SkeletonBlock
							>If you are the last member, deleting your account also deletes your company and all
							its data.</SkeletonBlock
						>
					</div>
				{:else if card.kind !== 'avatar'}
					<div class="mt-4 max-w-sm space-y-2">
						<SkeletonBlock
							class="h-9 w-full rounded-button-lg border-hairline border-edge shadow-control"
						/>
					</div>
				{/if}
				{#snippet footer()}<SkeletonBlock class="w-fit">{card.footer}</SkeletonBlock>{/snippet}
			</SettingsCard>
		{/each}
	</div>
</div>
