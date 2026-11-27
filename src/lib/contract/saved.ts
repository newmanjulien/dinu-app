import { ConvexError, type Infer } from 'convex/values';
import type {
	contractMetadata,
	liveContractMetadata,
	contractState,
	saveResult
} from '../../convex/savedContractValidators';
import type { Id } from '../../convex/_generated/dataModel';
import type { TemplateContent } from '../template/model';

export type ReadyContract = {
	id: string;
	status: 'ready';
	snapshot: TemplateContent;
	contract: Infer<typeof contractMetadata>;
};
export type ContractState = Infer<typeof contractState>;
export type LiveContractMetadata = Infer<typeof liveContractMetadata>;
export type ContractBuyerLink = NonNullable<LiveContractMetadata['buyerLink']>;
export type LiveContractState = Omit<
	LiveContractMetadata,
	'buyerName' | 'requestDelivery' | 'buyerLink' | 'hasUnreadComment' | 'latestQuote'
>;

export function persistedContractMetadata({
	buyerName: _buyerName,
	requestDelivery: _requestDelivery,
	buyerLink: _buyerLink,
	hasUnreadComment: _hasUnreadComment,
	latestQuote: _latestQuote,
	...metadata
}: LiveContractMetadata): LiveContractState {
	return metadata;
}
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
export function isHubSpotInstallationRetired(error: unknown) {
	return (
		error instanceof ConvexError &&
		error.data !== null &&
		typeof error.data === 'object' &&
		'code' in error.data &&
		error.data.code === 'hubspot-installation-retired'
	);
}

/** Canonical metadata has one freshness version, independent of business revisions. */
export function olderContractState(next: ContractState, current: ContractState) {
	return next.metadataRevision < current.metadataRevision;
}

export type ContractCreationInput =
	| { kind: 'manual'; name: string }
	| { kind: 'deal'; dealId: string; connectionId: Id<'hubspotConnections'> };
