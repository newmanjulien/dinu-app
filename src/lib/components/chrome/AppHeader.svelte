<script lang="ts">
	import { page } from '$app/state';
	import { describeRoute } from '$lib/auth/routes';
	import type { Snippet } from 'svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import { goto } from '$app/navigation';
	const viewer = useViewer();
	const session = useViewerSession();
	let menuOpen = $state(false);
	let trigger = $state<HTMLButtonElement>();

	let { actions, children }: { actions?: Snippet; children?: Snippet } = $props();
	const navItems = [
		{ label: 'Home', href: '/' },
		{ label: 'Admin', href: '/admin' }
	];
</script>

<header class="sticky top-0 z-40 h-[var(--app-header-height)] border-b border-line/60 bg-surface">
	<div class="flex h-full w-full items-stretch px-1.5 sm:px-2.5 md:px-4">
		<nav class="flex h-full shrink-0 items-stretch" aria-label="Primary navigation">
			{#each navItems as item (item.href)}
				{@const active = describeRoute(page.route.id).navigation === item.href}
				<a
					class="relative mr-0.5 flex items-center px-1.5 text-[13px] leading-none transition-colors sm:mr-3"
					class:text-ink={active}
					class:text-ink-muted={!active}
					aria-current={active ? 'page' : undefined}
					href={item.href}
				>
					{item.label}
					{#if active}<span class="absolute inset-x-0 bottom-0 h-0.5 bg-ink" aria-hidden="true"
						></span>{/if}
				</a>
			{/each}
		</nav>
		<div class="my-auto ml-auto flex min-w-0 items-center gap-1.5 sm:gap-3">
			{#if actions}{@render actions()}{/if}
			<button
				bind:this={trigger}
				class="inline-flex size-6.5 cursor-pointer items-center justify-center rounded-full transition-shadow duration-150 hover:ring-3 hover:ring-[#f5f5f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
				aria-label="Your account"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				aria-controls="account-menu"
				onclick={() => (menuOpen = !menuOpen)}
				><Avatar
					name={viewer().profile.name || viewer().profile.email}
					avatarUrl={viewer().profile.avatarUrl}
					size={26}
				/></button
			>
			<Menu
				open={menuOpen}
				{trigger}
				onClose={() => (menuOpen = false)}
				id="account-menu"
				label="Your account"
			>
				{#snippet children(close)}
					{#each [{ label: 'Settings', href: '/settings' }, { label: 'Manage team', href: '/team' }] as item}
						<MenuItem
							onclick={() => {
								close();
								void goto(item.href);
							}}>{item.label}</MenuItem
						>
					{/each}
					<MenuItem
						onclick={() => {
							close();
							void session.signOut();
						}}>Log out</MenuItem
					>
				{/snippet}
			</Menu>
		</div>
	</div>
	{#if children}{@render children()}{/if}
</header>
