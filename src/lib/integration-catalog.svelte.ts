import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
import { getIntegrationCatalog } from '$lib/integrations';

/** Normalize provider connection states into the workspace's integration catalog. */
export function useIntegrationCatalog() {
	const hubspot = useHubSpotDeals().connection;
	const entries = $derived(
		getIntegrationCatalog({
			hubspot: hubspot.data?.status === 'connected' || hubspot.data?.status === 'reconnect'
		})
	);
	return {
		get entries() {
			return entries;
		}
	};
}
