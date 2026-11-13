<script lang="ts">
	import { useWorkspacePresentation } from '$lib/auth/workspace-presentation.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
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
	import { loadSavedContract } from '$lib/auth/destination-code';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import NewContract from './NewContract.svelte';
	import { getContractEditors } from '$lib/contract/editors.svelte';
	const documentNavigation = getDocumentNavigation();
	const runtime = getWorkspaceRuntime();
	const presentation = useWorkspacePresentation();
	const session = useViewerSession();
	const editors = getContractEditors();
	let { data }: { data: ContractDestination } = $props();
	const savedKey = $derived(data.kind === 'saved' ? data.id : '');
	let savedRequested = $state(false);
	let savedOwner = $state.raw<{ id: string }>();
	// Teardown can expose old reactive values; ownership uses the current plain token.
	let savedOwnerToken: object | undefined;
	function acquiredSaved(id: string) {
		const owner = { id };
		savedOwnerToken = owner;
		savedOwner = owner;
		return () => {
			if (savedOwnerToken !== owner) return;
			savedOwnerToken = undefined;
			savedOwner = undefined;
		};
	}
	function prepareSavedEditor(id: Id<'savedContracts'>) {
		const opening = editors.acquire(id);
		// Explicit opening retries already have a saved component retaining this editor.
		if (savedOwnerToken && savedOwner?.id === id) opening.release();
		return opening.release;
	}
	$effect(() => {
		if (data.kind !== 'saved' || runtime.paused || savedOwner?.id === savedKey) return;
		const id = data.id;
		let active = true;
		let opening: ReturnType<typeof editors.acquire> | undefined;
		// The membership-owned editor must not inherit this short-lived route effect.
		queueMicrotask(() => {
			if (active) opening = editors.acquire(id);
		});
		return () => {
			active = false;
			opening?.release();
		};
	});
	const saved = loadComponent(
		loadSavedContract,
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
		if (attempt > 0) editors.retry(id);
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
	{#if SavedContract && runtime.hostReady}{#key `${savedKey}:${attempt}`}
			{@const mountedId = data.id}
			{@const mountedAttempt = attempt}
			<!-- Preparation can finish before the naming dialog hands off the workspace. -->
			<SavedContract
				id={mountedId}
				onAcquired={() => acquiredSaved(savedKey)}
				interactionAdmitted={!creating}
				onVisible={() => visible(mountedId, mountedAttempt)}
				onFailure={() => failure(mountedId, mountedAttempt)}
			/>
		{/key}
	{:else if runtime.error || saved.failed}
		<WorkspacePresentationReporter active={!creating} outcome="error" />
		<LoadingState layout="workspace">
			<p role="alert" class="text-sm">{runtime.error || 'We couldn’t load the contract viewer.'}</p>
			<button
				class="text-sm underline"
				onclick={() => {
					presentation?.restart();
					runtime.error ? runtime.retry() : saved.retry();
				}}>Try again</button
			>
		</LoadingState>
	{:else}<WorkspacePresentationReporter active={!creating} outcome="pending" /><DocumentSkeleton
			layout="contract"
			label="Loading contract"
		/>{/if}
{/if}
{#if creating}<NewContract
		onOpen={openSaved}
		onCreate={prepareSaved}
		onPrepareSaved={prepareSavedEditor}
		showPreview={!creationTarget}
	/>{/if}
