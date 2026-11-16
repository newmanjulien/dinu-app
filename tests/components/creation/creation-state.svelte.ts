import type { WorkspaceRuntime } from '../../../src/lib/auth/workspace-context.svelte';
import type { HubSpotDeals } from '../../../src/lib/hubspot-deals.svelte';
export function creationState() {
	const runtime = $state({
		hostReady: false as boolean,
		paused: false as boolean,
		error: '',
		navigationIntent: 0,
		retry() {}
	} satisfies WorkspaceRuntime);
	const factory = $state({ ready: false as boolean });
	const connection = $state({ data: undefined, isLoading: true, error: undefined } as {
		data: HubSpotDeals['connection']['data'];
		isLoading: boolean;
		error: Error | undefined;
	});
	return { runtime, factory, connection };
}
