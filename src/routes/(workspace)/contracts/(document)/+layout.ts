import type { ContractDestination } from '$lib/contract/saved';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = ({ params }) => ({
	contractDestination: (params.id
		? { kind: 'saved', id: params.id }
		: { kind: 'new' }) satisfies ContractDestination
});
