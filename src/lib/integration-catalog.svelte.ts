import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
import { getIntegrationCatalog } from '$lib/integrations';

/** Normalize provider connection states into the workspace's integration catalog. */
export function useIntegrationCatalog() {
	const hubspot = useHubSpotDeals().connection;
	const error = $derived(hubspot.error);
	const loading = $derived(!error && hubspot.data === undefined);
	const entries = $derived(
		getIntegrationCatalog({
			hubspot: hubspot.data?.status === 'connected' || hubspot.data?.status === 'reconnect',
			'hubspot-quote': hubspot.data?.quotes?.installed
		})
	);
	return {
		get loading() {
			return loading;
		},
		get error() {
			return error;
		},
		retry: () => hubspot.retry?.(),
		get entries() {
			return entries;
		}
	};
}
