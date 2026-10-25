<script lang="ts">
	import { untrack } from 'svelte';
	import Layout from '../../src/routes/(workspace)/contracts/+layout.svelte';
	import { ContractSessions, setContractSessions } from '../../src/lib/contract/sessions.svelte';
	import { setWorkspaceRuntime } from '../../src/lib/auth/workspace-context.svelte';
	import { setViewerSession, setViewer } from '../../src/lib/auth/viewer-session.svelte';
	import type { Viewer } from '../../src/lib/auth/viewer-session.svelte';
	import { screen, goto } from './navigation.svelte';
	let { sessions }: { sessions: ContractSessions } = $props();
	untrack(() => setContractSessions(sessions));
	setWorkspaceRuntime({ ready: true, paused: false, error: '', navigationIntent: 0, retry() {} });
	setViewerSession({
		userId: 'user',
		phase: 'ready',
		blocked: false,
		closing: false,
		transportGeneration: 0
	} as ReturnType<typeof import('../../src/lib/auth/viewer-session.svelte').useViewerSession>);
	setViewer(() => ({ company: { id: 'company' }, membership: { id: 'membership' } }) as Viewer);
</script>

<button onclick={() => goto('/')}>Home</button>
{#if screen.home}<main>Home content</main>{:else}<Layout
		data={{ contractDestination: screen.destination }}>{#snippet children()}{/snippet}</Layout
	>{/if}
