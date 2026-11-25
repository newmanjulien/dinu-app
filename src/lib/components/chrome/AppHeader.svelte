<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import AppHeaderLayout from './AppHeaderLayout.svelte';
	import AccountMenu from './AccountMenu.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import { goto } from '$app/navigation';
	import { getWorkspaceDestinations } from '$lib/auth/workspace-context.svelte';
	const destinations = getWorkspaceDestinations();
	const viewer = useViewer();
	const session = useViewerSession();
	function warmTemplate(path = '/template') {
		if (
			session.blocked ||
			session.closing ||
			viewer().company.deletion ||
			!viewer().permissions.manageTemplate ||
			!viewer().templateReady
		)
			return;
		destinations?.prepare(path);
	}
	let templateMenuOpen = $state(false);
	let templateTrigger = $state<HTMLButtonElement>();
	let templateAnchor = $state<HTMLDivElement>();
	let element = $state<HTMLElement>();

	let { children, notice }: { children?: Snippet; notice?: Snippet } = $props();
	onMount(() => {
		const root = document.documentElement;
		const measure = () =>
			root.style.setProperty('--app-header-height', `${element!.getBoundingClientRect().height}px`);
		const observer = new ResizeObserver(measure);
		observer.observe(element!);
		measure();
		return () => {
			observer.disconnect();
			root.style.removeProperty('--app-header-height');
		};
	});
</script>

<AppHeaderLayout
	permissions={viewer().permissions}
	templateReady={viewer().templateReady}
	loading={false}
	bind:element
	bind:templateAnchor
	bind:templateTrigger
	audienceOpen={templateMenuOpen}
	onToggleAudience={() => (templateMenuOpen = !templateMenuOpen)}
	onWarmTemplate={() => warmTemplate()}
	{notice}
	{children}
>
	{#snippet account()}<AccountMenu
			profile={viewer().profile}
			onSignOut={() => session.signOut()}
		/>{/snippet}
	{#snippet audience()}
		<Menu
			open={templateMenuOpen}
			trigger={templateTrigger}
			anchor={templateAnchor}
			placement="bottom-start"
			gap={6}
			onClose={() => (templateMenuOpen = false)}
			id="template-audience-menu"
			label="Template audience"
		>
			{#snippet children(close)}
				{#each [{ label: 'Rep template', href: '/template' }, { label: 'Buyer template', href: '/template/buyers' }] as destination}
					<MenuItem
						onpointerenter={() => warmTemplate(destination.href)}
						onfocus={() => warmTemplate(destination.href)}
						onclick={() => {
							warmTemplate(destination.href);
							close();
							void goto(destination.href);
						}}>{destination.label}</MenuItem
					>
				{/each}
			{/snippet}
		</Menu>
	{/snippet}
</AppHeaderLayout>
