<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import AuthEntryShell from '$lib/auth/components/AuthEntryShell.svelte';
	import { setEntryPresentation } from '$lib/auth/entry-presentation.svelte';
	import { localReturn } from '$lib/auth/navigation';
	import { useAccount, useViewerSession } from '$lib/auth/viewer-session.svelte';
	let { children } = $props();
	const presentation = setEntryPresentation();
	const account = useAccount();
	const session = useViewerSession();
	const joining = $derived(page.url.pathname === '/join');
	const accountEntry = $derived(joining || page.url.pathname === '/login');
	const accountHref = $derived(
		`${resolve(joining ? '/login' : '/join')}?returnTo=${encodeURIComponent(localReturn(page.url.searchParams.get('returnTo')))}` as const
	);
</script>

<AuthEntryShell
	showFooter={presentation.showFooter && Boolean(accountEntry || account?.())}
	signupStep={presentation.signupStep}
>
	{#snippet footer()}
		{#if accountEntry}
			<p class="m-0 text-[13px] leading-5 text-ink-muted">
				{joining ? 'Already have an account?' : 'Need an account?'}
				<a
					href={accountHref}
					class="text-ink-muted underline underline-offset-2 transition-colors hover:text-ink"
				>
					{joining ? 'Log in' : 'Join'}
				</a>
			</p>
		{:else if account?.()}
			<button
				class="mt-1 text-[13px] text-ink-muted underline underline-offset-2 hover:text-ink"
				onclick={() => void session.signOut()}>Switch account</button
			>
		{/if}
	{/snippet}
	{@render children()}
</AuthEntryShell>
