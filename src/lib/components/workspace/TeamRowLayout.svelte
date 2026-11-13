<script lang="ts">
	import type { Snippet } from 'svelte';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	let {
		invitations = false,
		canManage = false,
		avatar,
		identity,
		actions
	}: {
		invitations?: boolean;
		canManage?: boolean;
		avatar?: Snippet;
		identity?: Snippet;
		actions?: Snippet;
	} = $props();
</script>

<li class="flex flex-wrap items-center gap-3 p-3.5">
	{#if !invitations}{#if avatar}{@render avatar()}{:else}<SkeletonBlock
				class="size-7 shrink-0 rounded-full"
			/>{/if}{/if}
	<div class="min-w-0 flex-1">
		{#if identity}{@render identity()}{:else}<SkeletonBlock
				class="h-5 w-40 max-w-[70%]"
			/><SkeletonBlock class="h-4 w-52 max-w-[85%]" />{/if}
	</div>
	{#if actions}{@render actions()}{:else if invitations}<SkeletonBlock
			class="h-button-sm shrink-0 rounded-button-lg px-[13px] py-[7.5px] text-[12.5px]"
			>Resend</SkeletonBlock
		><SkeletonBlock
			class="h-button-sm shrink-0 rounded-button-lg px-[13px] py-[7.5px] text-[12.5px]"
			>Revoke</SkeletonBlock
		>{:else}<SkeletonBlock class="h-4 w-8 shrink-0" />{#if canManage}<SkeletonBlock
				class="h-button-sm shrink-0 rounded-button-lg px-[13px] py-[7.5px] text-[12.5px]"
				>Remove</SkeletonBlock
			>{/if}{/if}
</li>
