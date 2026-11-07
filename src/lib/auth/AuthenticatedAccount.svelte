<script lang="ts">
	import AccountGate from './AccountGate.svelte';
	import SessionScope from './SessionScope.svelte';
	import { useViewerSession } from './viewer-session.svelte';
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
	const session = useViewerSession();
</script>

<SessionScope>
	<AccountGate>
		<div inert={session.workspaceAdmitted && (session.blocked || Boolean(session.error))}>
			{@render children()}
		</div>
	</AccountGate>
</SessionScope>
