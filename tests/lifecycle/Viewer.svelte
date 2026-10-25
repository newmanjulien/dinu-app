<script lang="ts">
	import { untrack } from 'svelte';
	import { rendering } from './rendering.svelte';
	import type { ContractSession } from '../../src/lib/contract/sessions.svelte';
	import type { Id } from '../../src/convex/_generated/dataModel';
	let {
		session,
		onVisible
	}: {
		session: ContractSession;
		onVisible?: () => void;
		snapshot?: unknown;
		onFailure?: () => void;
	} = $props();
	$effect(() => {
		if (rendering.ready) untrack(() => onVisible?.());
	});
</script>

<div aria-label="Contract viewer">{JSON.stringify(session.persistence?.choices)}</div>
<button onclick={() => session.persistence?.select('item-a' as Id<'playbookItems'>, 'preferred')}
	>Select concession</button
>
