<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { page } from '$app/state';
	import { describeRoute } from './routes';
	import { useViewer } from './viewer-session.svelte';
	import { setWorkspaceHelp } from './workspace-help';
	import HelpModal from '$lib/components/ui/modal/HelpModal.svelte';
	import { isHelpHidden } from '$lib/components/ui/modal/help-storage';
	let { children }: { children: Snippet } = $props();
	const viewer = useViewer();
	const pathname = $derived(page.url.pathname);
	const document = $derived(describeRoute(page.route.id).document);
	const variant = $derived(document === 'admin' ? 'admin' : document === 'saved' ? 'rep' : null);
	const available = $derived(
		Boolean(variant) &&
			!viewer().company.deletionPending &&
			(document !== 'admin' || viewer().templateReady)
	);
	let visible = $state(false);
	let holds = $state(0);
	setWorkspaceHelp({
		open: () => (visible = true),
		hold: () => {
			untrack(() => holds++);
			return () => untrack(() => holds--);
		}
	});
	$effect(() => {
		void pathname;
		const current = available ? variant : null;
		untrack(() => (visible = current ? !isHelpHidden(current) : false));
	});
</script>

{@render children()}
{#if available && variant && visible && !holds}
	{#key variant}
		<HelpModal
			{variant}
			isAdmin={variant === 'rep' && viewer().profile.role === 'admin'}
			onClose={() => (visible = false)}
		/>
	{/key}
{/if}
