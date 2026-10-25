import { ConvexError, type Infer } from 'convex/values';
import type {
	snapshot,
	selections,
	contractState,
	saveResult
} from '../../convex/savedContractValidators';
import type { Doc } from '../../convex/_generated/dataModel';

export type ContractSnapshot = Infer<typeof snapshot>;
export type SavedSelections = Infer<typeof selections>;
export type ContractState = Infer<typeof contractState>;
export type ContractSaveResult = Infer<typeof saveResult>;
export type ContractDestination = { kind: 'new' } | { kind: 'saved'; id: string };
export type ContractSnapshotResult = { id: string } & (
	| { status: 'ready'; snapshot: ContractSnapshot; contract: Doc<'savedContracts'> }
	| { status: 'loading' | 'missing' | 'error' }
);
export function saveError(error: unknown, fallback: string) {
	return error instanceof ConvexError && typeof error.data === 'string' ? error.data : fallback;
}
