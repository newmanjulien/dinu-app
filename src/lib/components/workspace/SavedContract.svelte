<script lang="ts">
	import { useWorkspacePresentation } from '$lib/auth/workspace-presentation.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { concessionSelections } from '$lib/contract/applications';
	import { onDestroy, untrack } from 'svelte';
	import { ReadAttempt } from '$lib/auth/attempt';
	import { useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { getContractEditors } from '$lib/contract/editors.svelte';
	import { creationPhase } from '$lib/contract/creation-perf';
	import { recordColdStart } from '$lib/document/runtime/render-perf';
	import LoadingPagination from '$lib/components/document/LoadingPagination.svelte';
	import { REVIEW_GUTTER_WIDTH } from '$lib/components/document/workspace-layout';
	import { selectedReviewApplications } from '$lib/contract/approval';
	import Button from '$lib/ui/Button.svelte';
	import RepWorkspace from './RepWorkspace.svelte';
	let {
		id,
		interactionAdmitted = true,
		onVisible,
		onFailure
	}: {
		id: string;
		interactionAdmitted?: boolean;
		onVisible?: () => void;
		onFailure?: () => void;
	} = $props();
	const mountedId = untrack(() => id);
	const sessions = getContractEditors();
	const acquired = untrack(() => sessions.acquire(mountedId));
	const editor = acquired.editor;
	const reviewGutter = $derived(
		editor.snapshot &&
			selectedReviewApplications(
				editor.snapshot.items,
				editor.persistence?.choices ??
					(editor.metadata ? concessionSelections(editor.metadata.applications) : {})
			).length
			? REVIEW_GUTTER_WIDTH
			: 0
	);
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

{#if opening && !openingError && !editor.error && !editor.viewError && !editor.initializing && editor.snapshot && editor.metadata && editor.persistence}
	{#key opening.token}
		{@const token = opening.token}
		<RepWorkspace
			snapshot={editor.snapshot}
			{editor}
			{interactionAdmitted}
			onVisible={() => visible(token)}
			onFailure={() => failure(token)}
		/>
	{/key}
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
			<p role="alert">We couldn’t load this contract.</p>
			<Button variant="secondary" class="mt-4" onclick={retry}>Try again</Button>
		{/if}
		<a href="/" class="mt-6 block underline">Back to Home</a>
	</main>
{:else}<WorkspacePresentationReporter
		active={interactionAdmitted && !runtime.paused}
		outcome="pending"
		revision={opening?.token}
	/><LoadingPagination label="Loading contract" {reviewGutter} />{/if}
