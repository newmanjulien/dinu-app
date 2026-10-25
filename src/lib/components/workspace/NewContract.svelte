<script lang="ts">
	import { beforeNavigate, goto } from '$app/navigation';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { getWorkspaceHelp } from '$lib/auth/workspace-help';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import { useViewerSession } from '$lib/auth/viewer-session.svelte';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';
	import CompanyNameDialog from '$lib/components/ui/modal/CompanyNameDialog.svelte';
	import type { Id } from '../../../convex/_generated/dataModel';
	let {
		onOpen,
		onCreate = () => {},
		showPreview = true
	}: {
		onOpen: (id: Id<'savedContracts'>) => Promise<boolean>;
		onCreate?: () => void;
		showPreview?: boolean;
	} = $props();
	const runtime = getWorkspaceRuntime();
	const session = useViewerSession();
	const help = getWorkspaceHelp();
	$effect(() => {
		if (!runtime.paused) return help?.hold();
	});
	const creation = loadComponent(
		() => import('./ContractCreation.svelte'),
		() => true,
		() => session.transportGeneration
	);
	const ContractCreation = $derived(creation.component);
	let controller = $state<{ submit: (name: string) => Promise<void> }>();
	let createdId = $state<Id<'savedContracts'> | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let deleted = $state(false);
	beforeNavigate((navigation) => {
		if (session.closing) return;
		if (session.blocked && !navigation.willUnload) {
			navigation.cancel();
			return;
		}
		if (busy && navigation.to?.url.pathname !== `/contracts/${createdId}`) navigation.cancel();
	});
	async function cancel() {
		if (busy) return;
		try {
			await goto('/');
		} catch {
			error = 'We couldn’t return to Home. Try again.';
		}
	}
</script>

{#if ContractCreation}
	<ContractCreation
		bind:this={controller}
		bind:createdId
		bind:busy
		bind:error
		bind:deleted
		{onOpen}
		{onCreate}
		{showPreview}
	/>
{:else if showPreview}
	<main inert aria-hidden="true" class="pointer-events-none pt-6 pb-12 blur-sm">
		<DocumentSkeleton embedded announce={false} />
	</main>
{/if}
<CompanyNameDialog
	title="Name your contract"
	open={!runtime.paused}
	submitLabel={runtime.error || creation.failed
		? 'Create contract'
		: !runtime.ready || !controller
			? 'Loading…'
			: deleted
				? 'Back to Home'
				: createdId
					? 'Open contract'
					: 'Create contract'}
	submitDisabled={!runtime.ready || !controller}
	busyLabel={createdId ? 'Opening…' : 'Creating…'}
	lockName={Boolean(createdId) || deleted}
	{busy}
	error={runtime.error ||
		(creation.failed ? 'We couldn’t create this contract. Try again.' : error)}
	onRetry={runtime.error ? runtime.retry : creation.failed ? creation.retry : undefined}
	onSubmit={(name) => void (deleted ? cancel() : controller?.submit(name))}
	onClose={() => void cancel()}
/>
