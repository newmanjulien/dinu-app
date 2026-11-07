<script lang="ts">
	import { useAccount, useViewerSession } from './viewer-session.svelte';
	import AccountLoading from './AccountLoading.svelte';
	import type { Snippet } from 'svelte';
	let { children, inline = false }: { children: Snippet; inline?: boolean } = $props();
	const account = useAccount();
	const session = useViewerSession();
</script>

{#if session.workspaceAdmitted && account?.() && !account()!.needsInitialization && !session.closing}
	{@render children()}
{:else}
	<AccountLoading {inline} />
{/if}
