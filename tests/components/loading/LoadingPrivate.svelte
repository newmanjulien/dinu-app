<script lang="ts">
	import { useAccount } from '../../../src/lib/auth/viewer-session.svelte';
	import { useAccountContext } from '../../../src/lib/auth/account-context.svelte';
	import { useReadQuery } from '../../../src/lib/auth/read-query.svelte';
	import { api } from '../../../src/convex/_generated/api';
	const account = useAccount();
	const auth = useAccountContext()!;
	const region = useReadQuery(api.accounts.setupHints, () =>
		auth.authenticated ? { membershipId: account()!.membership!.id } : 'skip'
	);
</script>

<main data-private-content>
	<p>{account()?.profile.email}</p>
	<input aria-label="Private draft" />
	{#if region.error}<p role="alert">
			Read failed <button onclick={() => region.retry()}>Retry region</button>
		</p>
	{:else if region.isLoading}<p role="status">Loading suggestions</p>
	{:else}<p>Suggestions ready</p>{/if}
</main>
