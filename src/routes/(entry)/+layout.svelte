<script lang="ts">
	import AuthEntryShell from '$lib/auth/components/AuthEntryShell.svelte';
	import { setEntryPresentation } from '$lib/auth/entry-presentation.svelte';
	import { useAccount, useViewerSession } from '$lib/auth/viewer-session.svelte';
	let { children } = $props();
	const presentation = setEntryPresentation();
	const account = useAccount();
	const session = useViewerSession();
</script>

<AuthEntryShell showFooter={presentation.showFooter && Boolean(presentation.footer || account?.())}>
	{#snippet footer()}
		{#if presentation.footer}{@render presentation.footer()}
		{:else if account?.()}
			<p class="m-0 text-[13px] leading-5 break-words text-ink-muted">
				Signed in as {account()!.profile.email}
			</p>
			<button
				class="mt-1 text-[13px] text-ink-muted underline underline-offset-2 hover:text-ink"
				onclick={() => void session.signOut()}>Switch account</button
			>
		{/if}
	{/snippet}
	{@render children()}
</AuthEntryShell>
