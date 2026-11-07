import { ConvexError, type Infer } from 'convex/values';
import type {
	contractMetadata,
	contractState,
	saveResult,
	snapshot
} from '../../convex/savedContractValidators';
export type TemplateContent = Infer<typeof snapshot>;
export type ReadyContract = {
	id: string;
	status: 'ready';
	snapshot: TemplateContent;
	contract: Infer<typeof contractMetadata>;
};
export type ContractState = Infer<typeof contractState>;
export type ContractSaveResult = Infer<typeof saveResult>;
export type ContractDestination = { kind: 'new' } | { kind: 'saved'; id: string };
export type ContractSnapshotResult =
	ReadyContract | { id: string; status: 'loading' | 'missing' | 'error' };

export function saveError(error: unknown, fallback: string) {
	if (!(error instanceof ConvexError)) return fallback;
	if (typeof error.data === 'string') return error.data;
	if (
		error.data &&
		typeof error.data === 'object' &&
		'message' in error.data &&
		typeof error.data.message === 'string'
	)
		return error.data.message;
	return fallback;
}

/** Only this durable server refusal proves that an uncertain deal attempt cannot commit later. */
export function isHubSpotDealConflict(error: unknown) {
	return (
		error instanceof ConvexError &&
		error.data !== null &&
		typeof error.data === 'object' &&
		'code' in error.data &&
		error.data.code === 'hubspot-deal-already-linked'
	);
}

/** Canonical metadata has one freshness version, independent of business revisions. */
export function olderContractState(next: ContractState, current: ContractState) {
	return next.stateVersion < current.stateVersion;
}

export type ContractCreationInput =
	{ kind: 'manual'; name: string } | { kind: 'deal'; dealId: string };
