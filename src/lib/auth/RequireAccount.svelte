<script lang="ts">
	import { useAccount, useViewerSession } from './viewer-session.svelte';
	import { useAccountContext } from './account-context.svelte';
	import { loadComponent } from './component-loader.svelte';
	import AccountLoading from './AccountLoading.svelte';
	import type { Snippet } from 'svelte';
	let {
		children,
		inline = false,
		loading
	}: {
		children: Snippet;
		inline?: boolean;
		loading?: Snippet<[{ announce: boolean }]>;
	} = $props();
	const account = useAccount();
	const owner = useAccountContext();
	const scope = loadComponent(
		() => import('./AccountContentScope.svelte'),
		() => Boolean(owner?.client)
	);
	const ContentScope = $derived(scope.component);
	const session = useViewerSession();
</script>

{#if session.workspaceAdmitted && account?.() && !account()!.needsInitialization && !session.closing}
	{#if !owner}{@render children()}
	{:else if ContentScope && owner.client}
		<div hidden={owner.rejected} inert={session.blocked || Boolean(session.error)}>
			<ContentScope>{@render children()}</ContentScope>
		</div>
	{:else}<AccountLoading {inline} {loading} />{/if}
{:else}
	<AccountLoading {inline} {loading} />
{/if}

{#if scope.failed}<p
		role="alert"
		class="fixed inset-x-4 bottom-4 z-50 rounded-lg bg-surface p-4 text-center text-sm"
	>
		We couldn’t open your account. <button class="underline" onclick={() => scope.retry()}
			>Try again</button
		>
	</p>{/if}
