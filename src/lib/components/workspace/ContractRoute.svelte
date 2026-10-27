<script lang="ts">
	import { untrack, onDestroy } from 'svelte';
	import { creationPhase } from '$lib/contract/creation-perf';
	import { goto } from '$app/navigation';
	import { getDocumentNavigation } from '$lib/document/runtime/navigation.svelte';
	import { page } from '$app/state';
	import type { Id } from '../../../convex/_generated/dataModel';
	import type { ContractDestination } from '$lib/contract/saved';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import LoadingPagination from '$lib/components/document/LoadingPagination.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import NewContract from './NewContract.svelte';
	const documentNavigation = getDocumentNavigation();
	const runtime = getWorkspaceRuntime();
	const session = useViewerSession();
	let { data }: { data: ContractDestination } = $props();
	let savedRequested = $state(false);
	const saved = loadComponent(
		() => import('./SavedContract.svelte'),
		() => data.kind === 'saved' || savedRequested,
		() => session.transportGeneration
	);
	const SavedContract = $derived(saved.component);
	function prepareSaved() {
		savedRequested = true;
		if (saved.failed) saved.retry();
	}
	let creating = $state(untrack(() => data.kind === 'new'));
	let creationTarget = $state<string | null>(null);
	let attempt = $state(0);
	let completion: ((success: boolean) => void) | undefined;
	$effect(() => {
		const next = data;
		untrack(() => {
			if (creating && next.kind === 'saved' && next.id === creationTarget) return;
			completion?.(false);
			completion = undefined;
			creating = next.kind === 'new';
			creationTarget = null;
		});
	});
	let active = true;
	onDestroy(() => {
		active = false;
		completion?.(false);
	});
	async function openSaved(id: Id<'savedContracts'>) {
		if (!active) return false;
		if (saved.failed) {
			saved.retry();
			return false;
		}
		completion?.(false);
		const currentAttempt = ++attempt;
		const opened = new Promise<boolean>((resolve) => {
			completion = resolve;
		});
		creationTarget = id;
		const releaseView = documentNavigation?.preserve(new URL(`/contracts/${id}`, page.url).href);
		try {
			if (data.kind !== 'saved' || data.id !== id)
				await goto(`/contracts/${id}`, { replaceState: true, noScroll: true, keepFocus: true });
			if (!active || attempt !== currentAttempt) return false;
			creationPhase('navigation-end');
			if (data.kind !== 'saved' || data.id !== id) return false;
			return await opened;
		} catch {
			return false;
		} finally {
			if (attempt === currentAttempt) {
				completion?.(false);
				completion = undefined;
			}
			releaseView?.();
		}
	}
	function visible(id: string, currentAttempt: number) {
		if (data.kind !== 'saved' || data.id !== id || attempt !== currentAttempt) return;
		// A failed attempt may recover in the background. Keep its retry dialog
		// until the user explicitly starts another opening attempt.
		if (!creating || !completion) return;
		completion?.(true);
		completion = undefined;
		creating = false;
		creationTarget = null;
	}
	function failure(id: string, currentAttempt: number) {
		if (data.kind !== 'saved' || data.id !== id || attempt !== currentAttempt) return;
		completion?.(false);
		completion = undefined;
	}
	$effect(() => {
		if (saved.failed && data.kind === 'saved') {
			const id = data.id;
			const currentAttempt = attempt;
			untrack(() => failure(id, currentAttempt));
		}
	});
</script>

{#if data.kind === 'saved' && (!creating || (creationTarget && attempt > 0))}
	{#if SavedContract && runtime.ready}{#key `${data.id}:${attempt}`}
			{@const mountedId = data.id}
			{@const mountedAttempt = attempt}
			<!-- Preparation can finish before the naming dialog hands off the workspace. -->
			<SavedContract
				id={mountedId}
				admitted={!creating}
				onVisible={() => visible(mountedId, mountedAttempt)}
				onFailure={() => failure(mountedId, mountedAttempt)}
			/>
		{/key}
	{:else if runtime.error || saved.failed}
		<LoadingState layout="workspace">
			<p role="alert" class="text-sm">{runtime.error || 'We couldn’t load the contract viewer.'}</p>
			<button
				class="text-sm underline"
				onclick={() => (runtime.error ? runtime.retry() : saved.retry())}>Try again</button
			>
		</LoadingState>
	{:else}<LoadingPagination label="Loading contract" />{/if}
{/if}
{#if creating}<NewContract
		onOpen={openSaved}
		onCreate={prepareSaved}
		showPreview={!creationTarget}
	/>{/if}
