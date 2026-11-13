import { v } from 'convex/values';
import { hubspotDestination } from './hubspotValidators';
import { reservationManifest } from './outputValidators';
import { exportRequest } from './savedContractValidators';

export const quoteRequest = exportRequest.extend({ destination: hubspotDestination });
/** The immutable source/actor/destination request lives in its existing operation receipt. */
export const quoteReservation = reservationManifest;

export const quoteScopes = ['crm.objects.quotes.read', 'crm.objects.quotes.write'] as const;
export const hasQuoteScopes = (scopes: readonly string[]) =>
	quoteScopes.every((scope) => scopes.includes(scope));
export const oauthPurpose = v.union(v.literal('base'), v.literal('quotes'));
export const quoteInstallation = v.object({
	companyId: v.id('company'),
	connectionId: v.id('hubspotConnections'),
	accountId: v.string(),
	enabled: v.boolean(),
	epoch: v.number(),
	installedAt: v.number(),
	installerId: v.id('profiles')
});
export const quoteState = v.union(
	v.literal('queued'),
	v.literal('dispatched'),
	v.literal('verifying'),
	v.literal('verified'),
	v.literal('rejected'),
	v.literal('unknown'),
	v.literal('attention'),
	v.literal('retired')
);
export const quoteProviderFailure = v.object({
	capturedAt: v.number(),
	expiresAt: v.number(),
	phase: v.union(
		v.literal('credentials'),
		v.literal('deal-read'),
		v.literal('create'),
		v.literal('verify')
	),
	purpose: v.union(v.literal('read'), v.literal('create')),
	stage: v.union(v.literal('attempted'), v.literal('not-attempted')),
	status: v.number(),
	retryAfter: v.number(),
	category: v.optional(v.string()),
	code: v.optional(v.string()),
	correlationId: v.optional(v.string())
});
export const quotePush = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	reservationReceiptId: v.id('operationReceipts'),
	documentId: v.id('contractDocuments'),
	// Indexed provider destination stays operational; immutable source/actor lives on the receipt.
	destination: hubspotDestination,
	canonicalKey: v.string(),
	fingerprint: v.string(),
	payloadHash: v.string(),
	state: quoteState,
	updatedAt: v.number(),
	dispatchedAt: v.optional(v.number()),
	fileId: v.optional(v.id('_storage')),
	payloadExpiresAt: v.optional(v.number()),
	dueAt: v.optional(v.number()),
	claim: v.optional(v.string()),
	leaseUntil: v.optional(v.number()),
	workId: v.optional(v.string()),
	readAttempts: v.number(),
	quoteId: v.optional(v.string()),
	previousQuoteId: v.optional(v.string()),
	url: v.optional(v.string()),
	message: v.optional(v.string()),
	providerFailure: v.optional(quoteProviderFailure),
	recoveryEvidence: v.optional(v.string())
});
export const quoteSummary = v.object({
	id: v.id('hubspotQuotePushes'),
	state: quoteState,
	canonicalKey: v.string(),
	url: v.union(v.string(), v.null()),
	message: v.union(v.string(), v.null())
});

/** Only a worker start owns a running lease; waiting claims have no execution reserve. */
export const quoteRunningUntil = (row: { leaseUntil?: number }) =>
	row.leaseUntil === undefined ? 0 : row.leaseUntil + 30_000;
