import { ConvexError, type Infer } from 'convex/values';
import type {
	snapshot,
	selections,
	contractState,
	contractMetadata,
	saveResult
} from '../../convex/savedContractValidators';
export type ContractSnapshot = Infer<typeof snapshot>;
export type ContractSnapshotItem = ContractSnapshot['items'][number];
export type ReadyContract = {
	id: string;
	status: 'ready';
	snapshot: ContractSnapshot;
	contract: Infer<typeof contractMetadata>;
};
export type SavedSelections = Infer<typeof selections>;
export type ContractState = Infer<typeof contractState>;
export type ContractSaveResult = Infer<typeof saveResult>;
export type ContractDestination = { kind: 'new' } | { kind: 'saved'; id: string };
export type ContractSnapshotResult =
	ReadyContract | { id: string; status: 'loading' | 'missing' | 'error' };

export function saveError(error: unknown, fallback: string) {
	return error instanceof ConvexError && typeof error.data === 'string' ? error.data : fallback;
}

/** Canonical metadata has one freshness version, independent of business revisions. */
export function olderContractState(next: ContractState, current: ContractState) {
	return next.stateVersion < current.stateVersion;
}
