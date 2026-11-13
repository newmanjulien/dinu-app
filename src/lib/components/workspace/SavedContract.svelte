<script lang="ts">
	import { useWorkspacePresentation } from '$lib/auth/workspace-presentation.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import RouteTitle from '$lib/auth/RouteTitle.svelte';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { onDestroy, untrack } from 'svelte';
	import { ReadAttempt } from '$lib/auth/attempt';
	import { useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { getContractEditors } from '$lib/contract/editors.svelte';
	import { creationPhase } from '$lib/contract/creation-perf';
	import { recordColdStart } from '$lib/document/runtime/render-perf';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';
	import Button from '$lib/ui/Button.svelte';
	import RepWorkspace from './RepWorkspace.svelte';
	let {
		id,
		interactionAdmitted = true,
		onVisible,
		onFailure,
		onAcquired
	}: {
		id: string;
		interactionAdmitted?: boolean;
		onVisible?: () => void;
		onFailure?: () => void;
		onAcquired?: () => () => void;
	} = $props();
	const mountedId = untrack(() => id);
	const sessions = getContractEditors();
	const acquired = untrack(() => sessions.acquire(mountedId));
	const editor = acquired.editor;
	const releaseOpeningOwner = untrack(() => onAcquired?.());
	onDestroy(() => releaseOpeningOwner?.());
	const account = useViewerSession();
	const runtime = getWorkspaceRuntime();
	const presentation = useWorkspacePresentation();
	let opening = $state.raw<{
		token: symbol;
		deadline: ReadAttempt;
		outcome: 'pending' | 'visible' | 'failed';
	}>();
	let openingError = $state(false);
	let retryAttempt = $state(0);
	let completionSettled = false;
	let active = true;
	onDestroy(() => {
		active = false;
		acquired.release();
	});
	$effect(() => {
		const ready = sessions.accessAvailable && !runtime.paused;
		const generation = account.transportGeneration;
		void retryAttempt;
		untrack(() => {
			openingError = false;
			opening = ready
				? {
						token: Symbol('contract-opening'),
						deadline: new ReadAttempt(15_000),
						outcome: 'pending'
					}
				: undefined;
		});
		const current = untrack(() => opening);
		if (!current) return;
		current.deadline.signal.addEventListener(
			'abort',
			() => {
				if (
					!active ||
					opening?.token !== current.token ||
					account.transportGeneration !== generation
				)
					return;
				openingError = true;
				failure(current.token);
			},
			{ once: true }
		);
		return () => current.deadline.complete();
	});
	$effect(() => {
		if (
			opening?.outcome !== 'pending' ||
			openingError ||
			editor.error ||
			editor.viewError ||
			editor.initializing
		)
			return;
		if (!editor.snapshot || !editor.metadata || !editor.persistence) return;
		untrack(() => {
			creationPhase('snapshot-ready');
			recordColdStart('contract-data-ready');
		});
	});
	$effect(() => {
		if (editor.error || editor.viewError || editor.metadata === null) {
			const token = opening?.token;
			if (token) untrack(() => failure(token));
		}
	});
	function visible(token: symbol) {
		if (!active || opening?.token !== token || opening.outcome !== 'pending') return;
		opening.deadline.complete();
		opening = { ...opening, outcome: 'visible' };
		if (!completionSettled) {
			completionSettled = true;
			onVisible?.();
		}
	}
	function failure(token: symbol) {
		if (!active || opening?.token !== token || opening.outcome !== 'pending') return;
		opening.deadline.complete();
		opening = { ...opening, outcome: 'failed' };
		if (!completionSettled) {
			completionSettled = true;
			onFailure?.();
		}
	}
	function retry() {
		presentation?.restart();
		retryAttempt++;
		editor.retry();
	}
</script>

{#if editor.metadata && editor.buyerName}
	<RouteTitle title={`Negotiate with ${editor.buyerName}`} />
{/if}

{#if editor.snapshot && editor.metadata && editor.persistence}
	<div hidden={Boolean(editor.error)} inert={!interactionAdmitted || account.blocked}>
		<RepWorkspace
			snapshot={editor.snapshot}
			openingRevision={opening?.token}
			{editor}
			{interactionAdmitted}
			onRetry={retry}
			onVisible={() => {
				if (opening) visible(opening.token);
			}}
			onFailure={() => {
				if (opening) failure(opening.token);
			}}
		/>
	</div>
	{#if openingError || editor.error || editor.viewError}<p
			role="alert"
			class="p-4 text-center text-sm"
		>
			We couldn’t refresh this contract. <button class="underline" onclick={retry}>Try again</button
			>
		</p>{/if}
{:else if openingError || editor.error || editor.viewError || editor.metadata === null}
	<WorkspacePresentationReporter
		active={interactionAdmitted && !runtime.paused}
		outcome="error"
		revision={opening?.token}
	/>
	<main class="mx-auto max-w-2xl px-6 py-12 text-center text-[13px] leading-5">
		{#if editor.metadata === null}
			<h1 class="text-sm font-medium">Contract not found</h1>
			<p class="mt-2 text-ink-muted">This contract may have been deleted.</p>
		{:else}
			<p role="alert">
				We couldn’t load this contract.
				{#if editor.journal.recoveryError}<button
						class="mt-3 block underline"
						onclick={() => {
							editor.discard();
							editor.retry();
						}}>Discard stored browser selections</button
					>{/if}
			</p>
			<Button variant="secondary" class="mt-4" onclick={retry}>Try again</Button>
		{/if}
		<a href="/contracts" class="mt-6 block underline">Back to Contracts</a>
	</main>
{:else}<WorkspacePresentationReporter
		active={interactionAdmitted && !runtime.paused}
		outcome="pending"
		revision={opening?.token}
	/><DocumentSkeleton layout="contract" label="Loading contract" />{/if}
