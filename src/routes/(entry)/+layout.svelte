<script lang="ts">
	import { page } from '$app/state';
	import AuthEntryShell from '$lib/auth/components/AuthEntryShell.svelte';
	import { setEntryPresentation } from '$lib/auth/entry-presentation.svelte';
	import {
		createAccountHref,
		isAccountEntryPath,
		isCreateAccountPath,
		localReturn,
		loginHref
	} from '$lib/auth/navigation';
	import { useAccount, useViewerSession } from '$lib/auth/viewer-session.svelte';
	let { children } = $props();
	const presentation = setEntryPresentation();
	const account = useAccount();
	const session = useViewerSession();
	const creatingAccount = $derived(isCreateAccountPath(page.url.pathname));
	const accountEntry = $derived(isAccountEntryPath(page.url.pathname));
	const destination = $derived(localReturn(page.url.searchParams.get('returnTo')));
	const accountHref = $derived(
		creatingAccount ? loginHref(destination) : createAccountHref(destination)
	);
</script>

<AuthEntryShell
	showFooter={presentation.showFooter && Boolean(accountEntry || account?.())}
	createAccountStep={presentation.createAccountStep}
>
	{#snippet footer()}
		{#if accountEntry}
			<p class="m-0 text-[13px] leading-5 text-ink-muted">
				{creatingAccount ? 'Already have an account?' : 'Need an account?'}
				<a
					href={accountHref}
					class="text-ink-muted underline underline-offset-2 transition-colors hover:text-ink"
				>
					{creatingAccount ? 'Log in' : 'Create account'}
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
