<script lang="ts">
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import UserIcon from 'phosphor-svelte/lib/UserIcon';
	import type { DiscussionAuthor } from './session.svelte';
	let { author, viewerKey }: { author: DiscussionAuthor; viewerKey?: string } = $props();
</script>

<div class="flex min-w-0 items-center gap-2">
	{#if !author.buyer}<Avatar
			name={author.name}
			avatarUrl={author.avatarUrl}
			class="size-8"
			decorative
		/>
	{:else}<span
			class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-hover text-ink-muted ring-1 ring-line"
			aria-hidden="true"><UserIcon size={19} weight="regular" /></span
		>{/if}
	<span class="min-w-0 truncate text-[13px] leading-[1.2] font-medium text-ink"
		>{author.key === viewerKey ? 'You' : author.name}</span
	>
</div>
