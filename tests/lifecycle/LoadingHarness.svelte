<script lang="ts">
	import { onDestroy } from 'svelte';
	import AuthBridge from '../../src/lib/auth/AuthBridge.svelte';
	import AccountSession from '../../src/lib/auth/AccountSession.svelte';
	import StartupDataProvider from '../../src/lib/auth/StartupDataProvider.svelte';
	import RequireAccount from '../../src/lib/auth/RequireAccount.svelte';
	import WorkspaceFrame from '../../src/lib/auth/WorkspaceFrame.svelte';
	import { setStartupPreparation } from '../../src/lib/auth/startup-preparation';
	import { setClerkReadiness } from '../../src/lib/auth/clerk-readiness';
	import LoadingPrivate from './LoadingPrivate.svelte';
	let { entry = false }: { entry?: boolean } = $props();
	const preparation = setStartupPreparation();
	setClerkReadiness({ status: 'ready', error: '', ready: async () => {}, retry: async () => {} });
	onDestroy(() => preparation.cancel());
</script>

<AuthBridge
	><StartupDataProvider
		><AccountSession>
			<WorkspaceFrame>
				{#if entry}<form><label>Email<input aria-label="Email" /></label></form>
				{:else}<RequireAccount><LoadingPrivate /></RequireAccount>{/if}
			</WorkspaceFrame>
		</AccountSession></StartupDataProvider
	></AuthBridge
>
