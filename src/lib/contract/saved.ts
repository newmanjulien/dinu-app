import { ConvexError, type Infer } from 'convex/values';
import type {
	snapshot,
	selections,
	contractState,
	contractMetadata,
	saveResult
} from '../../convex/savedContractValidators';
import {
	normalizePlaybookItem,
	type PlaybookItem
} from '../playbook/model';

/** Raw snapshots exist only at network/disk ingress so legacy ranges cannot spread through the app. */
export type StoredContractSnapshot = Infer<typeof snapshot>;
export type ContractSnapshotItem = Omit<StoredContractSnapshot['items'][number], 'trigger' | 'concessions'> &
	PlaybookItem;
export type ContractSnapshot = Omit<StoredContractSnapshot, 'items'> & {
	items: ContractSnapshotItem[];
};
export type StoredReadyContract = {
	id: string;
	status: 'ready';
	snapshot: StoredContractSnapshot;
	contract: Infer<typeof contractMetadata>;
};
export type ReadyContract = Omit<StoredReadyContract, 'snapshot'> & {
	snapshot: ContractSnapshot;
};
export type SavedSelections = Infer<typeof selections>;
export type ContractState = Infer<typeof contractState>;
export type ContractSaveResult = Infer<typeof saveResult>;
export type ContractDestination = { kind: 'new' } | { kind: 'saved'; id: string };
export type ContractSnapshotResult =
	| ReadyContract
	| { id: string; status: 'loading' | 'missing' | 'error' };

export function normalizeContractSnapshot(
	snapshot: StoredContractSnapshot | ContractSnapshot
): ContractSnapshot {
	let changed = false;
	const items = snapshot.items.map((item) => {
		const normalized = normalizePlaybookItem(item);
		changed ||= normalized !== item;
		return normalized;
	});
	return (changed ? { ...snapshot, items } : snapshot) as ContractSnapshot;
}

export function normalizeReadyContract(
	contract: StoredReadyContract | ReadyContract
): ReadyContract {
	const snapshot = normalizeContractSnapshot(contract.snapshot);
	return snapshot === contract.snapshot ? (contract as ReadyContract) : { ...contract, snapshot };
}
export function saveError(error: unknown, fallback: string) {
	return error instanceof ConvexError && typeof error.data === 'string' ? error.data : fallback;
}
