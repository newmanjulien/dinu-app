<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import AppHeaderLayout from './AppHeaderLayout.svelte';
	import AccountMenu from './AccountMenu.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import { goto } from '$app/navigation';
	import { warmDocumentDestination } from '$lib/auth/destination-code';
	const viewer = useViewer();
	const session = useViewerSession();
	function warmTemplate() {
		if (
			session.blocked ||
			session.closing ||
			viewer().company.deletionPending ||
			viewer().membership.role !== 'admin' ||
			!viewer().templateReady
		)
			return;
		warmDocumentDestination('template');
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
	role={viewer().membership.role}
	templateReady={viewer().templateReady}
	loading={false}
	bind:element
	bind:templateAnchor
	bind:templateTrigger
	audienceOpen={templateMenuOpen}
	onToggleAudience={() => (templateMenuOpen = !templateMenuOpen)}
	onWarmTemplate={warmTemplate}
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
						onclick={() => {
							warmTemplate();
							close();
							void goto(destination.href);
						}}>{destination.label}</MenuItem
					>
				{/each}
			{/snippet}
		</Menu>
	{/snippet}
</AppHeaderLayout>
