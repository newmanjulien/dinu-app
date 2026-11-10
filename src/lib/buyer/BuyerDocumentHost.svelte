<script lang="ts">
	import { LayoutProfiler } from '$lib/document/pagination/profiler';
	import { untrack } from 'svelte';
	import type { BuyerContract } from './contract.svelte';
	import BuyerDocument from './BuyerDocument.svelte';
	import { getBuyerActivity } from './activity.svelte';
	import RetainedDocumentMount from '$lib/components/document/RetainedDocumentMount.svelte';
	import LayoutProfileSurface from '$lib/components/document/LayoutProfileSurface.svelte';
	import {
		DocumentLayoutProfiles,
		setDocumentLayoutProfiles
	} from '$lib/document/runtime/layout-context.svelte';
	let { contract }: { contract: BuyerContract } = $props();
	const generation = untrack(() => contract.generation);
	const content = $derived(contract.content!);
	const profiles = setDocumentLayoutProfiles(
		new DocumentLayoutProfiles(untrack(() => contract.scheduler))
	);
	const active = $derived(contract.allowed && contract.foreground);
	const activity = getBuyerActivity();
	profiles.install(LayoutProfiler);
</script>

<LayoutProfileSurface bind:surface={profiles.surface} />
<RetainedDocumentMount target={contract.target} visible={active} interactive={active}>
	<BuyerDocument
		{content}
		token={contract.token}
		tools
		{active}
		prepare={contract.allowed}
		priority={contract.priority}
		failure={contract.error}
		onDisplayed={(content) => contract.bindDisplay(generation, content)}
		onClauseOpen={(itemId) => activity?.clauseOpened(contract.token, itemId)}
		onPresentation={(outcome) => untrack(() => contract.present(generation, outcome))}
		onFailure={(stage) => untrack(() => contract.fail(generation, stage))}
		onRetry={() => contract.retry()}
	/>
</RetainedDocumentMount>
