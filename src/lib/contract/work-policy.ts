import { ConvexError } from 'convex/values';

export type ContractWorkBlock = 'association-required' | 'deal-unavailable';
export const workBlockMessage = (block: ContractWorkBlock) =>
	block === 'association-required'
		? 'Link a HubSpot deal to edit, review or download this contract, or send links.'
		: 'This HubSpot deal is unavailable. Link another deal before continuing.';

export function workBlockFromError(error: unknown): ContractWorkBlock | null {
	const code = errorCode(error);
	return code === 'association-required' || code === 'deal-unavailable' ? code : null;
}

export function errorCode(error: unknown): string | undefined {
	if (!(error instanceof ConvexError) || !error.data || typeof error.data !== 'object') return;
	const code = (error.data as { code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}
