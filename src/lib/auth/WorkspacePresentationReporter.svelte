<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import {
		useWorkspacePresentation,
		type PresentationOutcome
	} from './workspace-presentation.svelte';
	let {
		outcome,
		active = true,
		revision
	}: {
		outcome: PresentationOutcome;
		active?: boolean;
		revision?: unknown;
	} = $props();
	const presentation = useWorkspacePresentation();
	const owner = Symbol('primary-surface');
	onDestroy(() => presentation?.release(owner));
	$effect(() => {
		if (!presentation) return;
		void presentation.identity();
		void presentation.revision;
		void active;
		void outcome;
		void revision;
		untrack(() => presentation.report(owner, () => ({ active, outcome, revision })));
	});
</script>
