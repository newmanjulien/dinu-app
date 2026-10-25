<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { ReadAttempt } from '$lib/auth/attempt';
	import { useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { getContractSessions } from '$lib/contract/sessions.svelte';
	import { creationPhase } from '$lib/contract/creation-perf';
	import { recordColdStart } from '$lib/document/runtime/render-perf';
	import LoadingPagination from '$lib/components/document/LoadingPagination.svelte';
	import RepWorkspace from './RepWorkspace.svelte';
	let { id, onVisible, onFailure }: { id: string; onVisible?: () => void; onFailure?: () => void } =
		$props();
	const mountedId = untrack(() => id);
	const sessions = getContractSessions();
	const acquired = untrack(() => sessions.acquire(mountedId));
	const session = acquired.session;
	const account = useViewerSession();
	const runtime = getWorkspaceRuntime();
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
		const ready = sessions.ready && !runtime.paused;
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
			session.error ||
			session.viewError ||
			session.initializing
		)
			return;
		if (!session.snapshot || !session.metadata || !session.persistence) return;
		untrack(() => {
			creationPhase('snapshot-ready');
			recordColdStart('contract-data-ready');
		});
	});
	$effect(() => {
		if (session.error || session.viewError || session.metadata === null) {
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
		retryAttempt++;
		session.retry();
	}
</script>

{#if opening && !openingError && !session.error && !session.viewError && !session.initializing && session.snapshot && session.metadata && session.persistence}
	{#key opening.token}
		{@const token = opening.token}
		<RepWorkspace
			snapshot={session.snapshot}
			{session}
			onVisible={() => visible(token)}
			onFailure={() => failure(token)}
		/>
	{/key}
{:else if openingError || session.error || session.viewError || session.metadata === null}
	<main class="mx-auto max-w-2xl px-6 py-12 text-center text-[13px] leading-5">
		{#if session.metadata === null}
			<h1 class="text-sm font-medium">Contract not found</h1>
			<p class="mt-2 text-ink-muted">This contract may have been deleted.</p>
		{:else}
			<p role="alert">We couldn’t load this contract.</p>
			<button class="mt-4 rounded-button-sm border border-line bg-surface px-4 py-2" onclick={retry}
				>Try again</button
			>
		{/if}
		<a href="/" class="mt-6 block underline">Back to Home</a>
	</main>
{:else}<LoadingPagination label="Loading contract" />{/if}
