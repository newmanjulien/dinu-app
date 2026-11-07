import { ConvexError } from 'convex/values';

export type ContractWorkBlock = 'association-required' | 'deal-unavailable';
export const workBlockMessage = (block: ContractWorkBlock) =>
	block === 'association-required'
		? 'Link a HubSpot deal before editing, reviewing or downloading this contract. The contract will be renamed to match the selected deal’s name.'
		: 'This HubSpot deal is unavailable. Link another deal before continuing. The contract will be renamed to match the selected deal’s name.';

export function workBlockFromError(error: unknown): ContractWorkBlock | null {
	if (!(error instanceof ConvexError) || !error.data || typeof error.data !== 'object') return null;
	const code = (error.data as { code?: unknown }).code;
	return code === 'association-required' || code === 'deal-unavailable' ? code : null;
}

export function errorCode(error: unknown): string | undefined {
	if (!(error instanceof ConvexError) || !error.data || typeof error.data !== 'object') return;
	const code = (error.data as { code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}
