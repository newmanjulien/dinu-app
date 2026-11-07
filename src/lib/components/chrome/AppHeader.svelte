<script lang="ts">
	import { page } from '$app/state';
	import { describeRoute } from '$lib/auth/routes';
	import { onMount, type Snippet } from 'svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import { goto } from '$app/navigation';
	const viewer = useViewer();
	const session = useViewerSession();
	let menuOpen = $state(false);
	let trigger = $state<HTMLButtonElement>();
	let element: HTMLElement;

	let { children, notice }: { children?: Snippet; notice?: Snippet } = $props();
	onMount(() => {
		const root = document.documentElement;
		const measure = () =>
			root.style.setProperty('--app-header-height', `${element.getBoundingClientRect().height}px`);
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		measure();
		return () => {
			observer.disconnect();
			root.style.removeProperty('--app-header-height');
		};
	});
	const navItems = [
		{ label: 'Home', href: '/' },
		{ label: 'Admin', href: '/admin' }
	];
</script>

<header
	bind:this={element}
	data-app-header
	class="sticky top-0 z-40 border-b-[length:var(--surface-border-width)] border-line bg-surface"
>
	<div
		class="flex h-[calc(var(--app-nav-height)-var(--surface-border-width))] w-full items-stretch px-[3px] sm:px-[7px] md:px-[13px]"
	>
		<nav class="flex h-full shrink-0 items-stretch" aria-label="Primary navigation">
			{#each navItems as item (item.href)}
				{@const disabled = item.href === '/admin' && viewer().membership.role === 'rep'}
				{@const active = !disabled && describeRoute(page.route.id).navigation === item.href}
				<a
					class="relative mr-0.5 flex items-center px-1.5 pt-0.5 text-[13px] leading-none transition-colors sm:mr-3"
					class:text-ink={active}
					class:text-ink-muted={!active}
					class:opacity-40={disabled}
					class:cursor-not-allowed={disabled}
					role={disabled ? 'link' : undefined}
					aria-disabled={disabled || undefined}
					aria-current={active ? 'page' : undefined}
					tabindex={disabled ? -1 : undefined}
					href={disabled ? undefined : item.href}
				>
					{item.label}
					{#if active}<span class="absolute inset-x-0 bottom-0 h-0.5 bg-ink" aria-hidden="true"
						></span>{/if}
				</a>
			{/each}
		</nav>
		<div class="my-auto ml-auto flex min-w-0 items-center gap-1.5 sm:gap-3">
			<button
				bind:this={trigger}
				class="inline-flex size-[25px] cursor-pointer items-center justify-center rounded-full transition-shadow duration-150 hover:ring-3 hover:ring-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
				aria-label="Your account"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				aria-controls="account-menu"
				onclick={() => (menuOpen = !menuOpen)}
				><Avatar
					name={viewer().profile.name || viewer().profile.email}
					avatarUrl={viewer().profile.avatarUrl}
					class="size-[25px]"
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
	{#if notice}{@render notice()}{/if}
	{#if children}{@render children()}{/if}
</header>
