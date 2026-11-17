<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { describeRoute } from '$lib/auth/routes';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	let {
		role,
		templateReady = false,
		loading = true,
		element = $bindable(),
		templateAnchor = $bindable(),
		templateTrigger = $bindable(),
		audienceOpen = false,
		onToggleAudience,
		onWarmTemplate,
		audience,
		profile,
		account,
		notice,
		children
	}: {
		role?: 'admin' | 'rep';
		templateReady?: boolean;
		loading?: boolean;
		element?: HTMLElement;
		templateAnchor?: HTMLDivElement;
		templateTrigger?: HTMLButtonElement;
		audienceOpen?: boolean;
		onToggleAudience?: () => void;
		onWarmTemplate?: () => void;
		audience?: Snippet;
		profile?: { name: string; avatarUrl: string | null };
		account?: Snippet;
		notice?: Snippet;
		children?: Snippet;
	} = $props();
	const navItems = [
		{ label: 'Contracts', href: '/contracts', adminOnly: false },
		{ label: 'Template', href: '/template', adminOnly: true },
		{ label: 'Integrations', href: '/integrations', adminOnly: true },
		{ label: 'Guides', href: '/guides', adminOnly: false }
	];
	const visibleNavItems = $derived(navItems.filter((item) => !item.adminOnly || role === 'admin'));
</script>

<header
	bind:this={element}
	aria-busy={loading}
	inert={loading}
	data-app-header
	class="sticky top-0 left-0 z-40 border-b-[length:var(--surface-border-width)] border-line bg-surface"
>
	<div
		class="flex h-[calc(var(--app-nav-height)-var(--surface-border-width))] w-full items-stretch px-[3px] sm:px-[7px] md:px-[13px]"
	>
		<nav class="flex h-full shrink-0 items-stretch" aria-label="Primary navigation">
			{#each visibleNavItems as item (item.href)}
				{@const active = describeRoute(page.route.id).navigation === item.href}
				<div
					class="relative my-1 mr-[1.5px] flex items-stretch rounded-md transition-colors hover:bg-[#f7f7f7] sm:mr-2"
				>
					{#if item.href === '/template'}
						<div bind:this={templateAnchor} class="ml-[5.5px] flex items-stretch">
							<a
								class="flex items-center pr-[5.5px] pt-0.5 text-[13px] leading-none text-ink-muted transition-colors"
								aria-current={active ? 'page' : undefined}
								onpointerenter={onWarmTemplate}
								onfocus={onWarmTemplate}
								href={item.href}>{item.label}</a
							>
							{#if templateReady}
								<button
									type="button"
									bind:this={templateTrigger}
									class="-ml-1.5 flex w-5 cursor-pointer items-center justify-center text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
									aria-label="Choose template audience"
									aria-haspopup="menu"
									aria-expanded={audienceOpen}
									aria-controls="template-audience-menu"
									onpointerenter={onWarmTemplate}
									onfocus={onWarmTemplate}
									onclick={() => onToggleAudience?.()}
								>
									<CaretDownIcon class="size-3" weight="bold" aria-hidden="true" />
								</button>
								{@render audience?.()}
							{/if}
						</div>
					{:else}
						<a
							class="flex items-center px-[5.5px] pt-0.5 text-[13px] leading-none text-ink-muted transition-colors"
							aria-current={active ? 'page' : undefined}
							href={item.href}>{item.label}</a
						>
					{/if}
				</div>
			{/each}
		</nav>
		<div class="ml-auto flex min-w-0 items-stretch gap-1.5 sm:gap-3">
			{#if account}{@render account()}{:else}<div class="flex items-center">
					{#if profile}<Avatar
							name={profile.name}
							avatarUrl={profile.avatarUrl}
							class="size-[25px]"
						/>
					{:else}<SkeletonBlock class="size-[25px] rounded-full" />{/if}
				</div>{/if}
		</div>
	</div>
	{#if notice}{@render notice()}{/if}
	{#if children}{@render children()}{/if}
</header>
