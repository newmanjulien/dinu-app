<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Role } from '../../../convex/permissions';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import Button from '$lib/ui/Button.svelte';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import TeamRowsSkeleton from './TeamRowsSkeleton.svelte';
	let {
		role,
		companyName,
		canManage = role === 'admin',
		status,
		notice,
		invite,
		colleaguesContent,
		invitationsContent,
		leaveContent,
		feedback
	}: {
		role?: Role;
		companyName?: string;
		canManage?: boolean;
		status?: Snippet;
		notice?: Snippet;
		invite?: Snippet;
		colleaguesContent?: Snippet;
		invitationsContent?: Snippet;
		leaveContent?: Snippet;
		feedback?: Snippet;
	} = $props();
</script>

<main
	class="min-h-[calc(100dvh-var(--app-header-height))] bg-surface px-4 pt-8 pb-8 sm:px-6 md:px-8 md:pt-10"
	aria-busy={!colleaguesContent}
>
	{@render status?.()}
	<div class="mx-auto max-w-4xl space-y-8">
		<h1 class="text-lg font-medium">Manage team</h1>
		{@render notice?.()}
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0">
				{#if companyName !== undefined}<h2 class="text-sm font-medium">
						{companyName}
					</h2>{:else}<SkeletonBlock class="h-5 w-40" />{/if}
				<p class="mt-2 text-sm text-ink-muted">
					Your company is private. Colleagues join by invitation.
				</p>
			</div>
			{#if canManage}
				{#if invite}{@render invite()}{:else}<Button disabled
						><PlusIcon class="size-[15px]" aria-hidden="true" />Invite</Button
					>{/if}
			{/if}
		</div>
		<section aria-labelledby="colleagues-heading">
			<h2 id="colleagues-heading" class="mb-3 text-sm font-medium">Colleagues</h2>
			{#if colleaguesContent}{@render colleaguesContent()}{:else}<TeamRowsSkeleton
					{canManage}
				/>{/if}
		</section>
		{#if canManage}
			<section aria-labelledby="invitations-heading">
				<h2 id="invitations-heading" class="mb-3 text-sm font-medium">Pending invitations</h2>
				{#if invitationsContent}{@render invitationsContent()}{:else}<TeamRowsSkeleton
						invitations
					/>{/if}
			</section>
		{/if}
		{#if role}
			<section class="border-t-[length:var(--surface-border-width)] border-line pt-6">
				<h2 class="text-sm font-medium">Leave company</h2>
				{#if leaveContent}{@render leaveContent()}{:else}<SkeletonBlock
						class="mt-2 h-5 w-full max-w-lg"
					/>{/if}
			</section>
		{/if}
		{@render feedback?.()}
	</div>
</main>
