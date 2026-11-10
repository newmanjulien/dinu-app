<script lang="ts">
	import WorkspaceFrame from '$lib/auth/WorkspaceFrame.svelte';
	import RequireAccount from '$lib/auth/RequireAccount.svelte';
	import WorkspaceBoundary from '$lib/auth/WorkspaceBoundary.svelte';
	let { children } = $props();
</script>

<WorkspaceFrame
	><RequireAccount><WorkspaceBoundary>{@render children()}</WorkspaceBoundary></RequireAccount
	></WorkspaceFrame
>
