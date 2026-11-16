import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { canonicalJson } from '../lib/document/canonical-json';
import { receiptChunkFingerprint } from './operationReceipts';
import { EXPORT_ACKNOWLEDGEMENT_WINDOW, EXPORT_HOUR } from './exportRetention';
import { quoteRunningUntil } from './hubspotQuoteValidators';
import { outputReservation } from './outputProof';
import { deleteUnownedFile } from './storageOwnership';
import { releaseContractDocumentHold } from './contractDocumentLifetime';

export type FullOutput = Extract<Doc<'contractOutputs'>, { format: 'full' }>;
export type FullExportAttempt = Extract<Doc<'hubspotExports'>, { format: 'full' }>;
export type FullQuotePush = Extract<Doc<'hubspotQuotePushes'>, { format: 'full' }>;
export const OUTPUT_EVIDENCE_WINDOW = 90 * 24 * EXPORT_HOUR;
export const conclusiveQuote = (row: Doc<'hubspotQuotePushes'>) =>
	row.state === 'verified' || row.state === 'rejected' || row.state === 'retired';

export { outputHoldsDocument } from './contractDocumentLifetime';

async function related(ctx: QueryCtx, row: FullOutput) {
	const attempt = await ctx.db
		.query('hubspotExports')
		.withIndex('by_outputId', (q) => q.eq('outputId', row._id))
		.unique();
	const push = row.providerOperationId
		? await ctx.db.get('hubspotQuotePushes', row.providerOperationId)
		: null;
	for (const owner of [attempt, push])
		if (owner && (owner.companyId !== row.companyId || owner.contractId !== row.contractId))
			throw new Error('Output lifecycle ownership changed.');
	if (row.kind === 'output-reservation' && row.state === 'complete' && !attempt)
		throw new Error('Missing Word output attempt.');
	if (row.providerOperationId && !push) throw new Error('Missing output provider observation.');
	const delivery = attempt
		? await ctx.db
				.query('hubspotExportDeliveries')
				.withIndex('by_attemptId', (q) => q.eq('attemptId', attempt._id))
				.unique()
		: null;
	const event = attempt
		? await ctx.db
				.query('hubspotEvents')
				.withIndex('by_attemptId', (q) => q.eq('attemptId', attempt._id))
				.unique()
		: null;
	if (
		(delivery && delivery.companyId !== row.companyId) ||
		(event && (event.companyId !== row.companyId || event.contractId !== row.contractId))
	)
		throw new Error('Output delivery ownership changed.');
	return { attempt, push, delivery, event };
}
const eventConclusive = (event: Doc<'hubspotEvents'>) =>
	(event.status === 'sent' || event.status === 'retired') &&
	!event.dispatch &&
	!event.observation &&
	!event.operatorObservation &&
	!event.workId &&
	!event.claim &&
	event.leaseUntil === undefined;

/** Derive settlement from original lifecycle facts, including when a sweeper discovers
 * a reused observation later. Reads, acknowledgements and retries never supply a clock. */
export async function settleOutput(ctx: MutationCtx, outputId: Id<'contractOutputs'>) {
	const row = await ctx.db.get('contractOutputs', outputId);
	if (!row || row.format !== 'full' || row.settledAt !== undefined) return;
	const { attempt, push } = await related(ctx, row);
	if (row.outputPreparation || row.receiptId || row.state !== 'complete') return;
	let at: number;
	if (row.kind === 'output-reservation') {
		if (attempt?.releasedAt === undefined) return;
		at = attempt.releasedAt;
	} else {
		if (
			!push ||
			!conclusiveQuote(push) ||
			push.settledAt === undefined ||
			row.committedAt === undefined
		)
			return;
		if (push.format === 'full' && (push.leaseUntil !== undefined || push.workId || push.claim))
			return;
		at = Math.max(row.committedAt, push.settledAt);
	}
	await ctx.db.patch('contractOutputs', row._id, {
		settledAt: at,
		evidenceUntil: at + OUTPUT_EVIDENCE_WINDOW,
		retentionDueAt: at + OUTPUT_EVIDENCE_WINDOW
	});
}
/** Call after a conclusive provider transition has explicitly ended its execution lease.
 * Unknown/attention/verifying outcomes remain full regardless of the passage of time. */
export async function settleQuoteOutput(ctx: MutationCtx, id: Id<'hubspotQuotePushes'>) {
	const push = await ctx.db.get('hubspotQuotePushes', id);
	if (
		!push ||
		push.format !== 'full' ||
		!conclusiveQuote(push) ||
		push.leaseUntil !== undefined ||
		push.workId ||
		push.claim
	)
		return;
	if (push.settledAt === undefined)
		await ctx.db.patch('hubspotQuotePushes', id, { settledAt: Date.now() });
	await settleOutput(ctx, push.outputId);
}

export type OutputReadiness =
	{ kind: 'compact' | 'dispose' } | { kind: 'held'; reason: string; until?: number };
/** Bounded dependency gate for the sweeper. It never changes outcomes or infers provider failure. */
export async function outputReadiness(
	ctx: QueryCtx,
	row: FullOutput,
	now: number
): Promise<OutputReadiness> {
	if (row.receiptId || row.outputPreparation || row.outputCleanup)
		return { kind: 'held', reason: 'private-work' };
	const marker = await ctx.db
		.query('contractCleanups')
		.withIndex('by_contractId', (q) => q.eq('contractId', row.contractId))
		.unique();
	if (
		marker?.retentionProof?.outputId === row._id ||
		marker?.retentionDocumentId === row.documentId
	)
		return { kind: 'held', reason: 'deletion-preflight' };
	const { attempt, push, delivery, event } = await related(ctx, row);
	if (
		push &&
		(!conclusiveQuote(push) ||
			(push.format === 'full' && (quoteRunningUntil(push) > now || push.workId || push.claim)))
	)
		return { kind: 'held', reason: 'provider-outcome' };
	if (event && !eventConclusive(event)) return { kind: 'held', reason: 'delivery-outcome' };
	if (delivery?.attachmentUntil !== undefined && delivery.attachmentUntil + 15 * 60_000 > now)
		return { kind: 'held', reason: 'attachment', until: delivery.attachmentUntil + 15 * 60_000 };
	if (attempt?.format === 'full') {
		if (attempt.fileId || attempt.deletingFileId)
			return { kind: 'held', reason: 'file-deletion', until: attempt.expiresAt };
		if (attempt.state !== 'expired')
			return { kind: 'held', reason: 'local-file-window', until: attempt.expiresAt };
		if (
			attempt.releasedAt !== undefined &&
			now < attempt.releasedAt + EXPORT_ACKNOWLEDGEMENT_WINDOW
		)
			return {
				kind: 'held',
				reason: 'acknowledgement',
				until: attempt.releasedAt + EXPORT_ACKNOWLEDGEMENT_WINDOW
			};
	}
	if (push?.format === 'full' && (push.fileId || push.deletingFileId))
		return { kind: 'held', reason: 'payload-deletion', until: push.payloadExpiresAt };
	if (row.settledAt === undefined) {
		if (now < row.executionUntil)
			return { kind: 'held', reason: 'operation', until: row.executionUntil };
		if (attempt?.releasedAt !== undefined || push) return { kind: 'held', reason: 'settlement' };
		return { kind: 'dispose' };
	}
	if (row.evidenceUntil !== row.settledAt + OUTPUT_EVIDENCE_WINDOW)
		throw new Error('Output evidence deadline changed.');
	return now < row.evidenceUntil
		? { kind: 'held', reason: 'evidence', until: row.evidenceUntil }
		: { kind: 'compact' };
}

/** Clear deletion obligations only after the storage row is actually absent. */
export async function finishOutputFileDeletion(
	ctx: MutationCtx,
	row: FullExportAttempt | FullQuotePush
) {
	if (!row.deletingFileId) return true;
	await deleteUnownedFile(ctx, row.deletingFileId);
	if (await ctx.db.system.get('_storage', row.deletingFileId)) return false;
	if ('canonicalKey' in row)
		await ctx.db.patch('hubspotQuotePushes', row._id, { deletingFileId: undefined });
	else await ctx.db.patch('hubspotExports', row._id, { deletingFileId: undefined });
	return true;
}

/** One bounded compaction/disposal turn; the collector owns discovery, budgets and continuations. */
export async function compactOutput(
	ctx: MutationCtx,
	outputId: Id<'contractOutputs'>,
	now: number
) {
	await settleOutput(ctx, outputId);
	const row = await ctx.db.get('contractOutputs', outputId);
	if (!row || row.format === 'compact') return 'ready' as const;
	const owners = await related(ctx, row);
	for (const owner of [owners.attempt, owners.push])
		if (owner?.format === 'full' && owner.deletingFileId) {
			return (await finishOutputFileDeletion(ctx, owner))
				? ('pending' as const)
				: { kind: 'held' as const, reason: 'file-deletion' };
		}
	const readiness = await outputReadiness(ctx, row, now);
	if (readiness.kind === 'held') return readiness;
	let fact = row.compaction;
	if (readiness.kind === 'compact' && !fact) {
		const { reservationManifest: manifest } = await outputReservation(ctx, { ...row, outputId });
		const attempt = owners.attempt;
		fact = {
			title: manifest.title,
			profileId: manifest.actor.profileId,
			membershipId: manifest.membershipId,
			requestedAt: manifest.requestedAt,
			documentFingerprint: manifest.documentFingerprint,
			sourceFingerprint: receiptChunkFingerprint(canonicalJson(manifest.expectedSource)),
			proofIdentity: manifest.identity,
			proofHash: manifest.proof.hash,
			proofBindingHash: manifest.proof.bindingHash,
			destination: manifest.destination,
			...(attempt
				? {
						attemptId: attempt._id,
						filename: attempt.filename,
						sha256: attempt.sha256,
						size: attempt.size,
						releasedAt: attempt.releasedAt,
						acknowledgedAt: attempt.acknowledgedAt,
						acknowledgedOn: attempt.acknowledgedOn
					}
				: {}),
			...(owners.event || owners.delivery
				? {
						delivery: {
							destination: (owners.event ?? owners.delivery)!.destination,
							state: owners.event
								? owners.event.status === 'sent'
									? ('sent' as const)
									: ('retired' as const)
								: undefined,
							remoteFileId: owners.delivery?.remoteFileId ?? owners.event?.fileId,
							noteId: owners.event?.noteId
						}
					}
				: {})
		};
		await ctx.db.patch('contractOutputs', row._id, { compaction: fact });
	}
	if (readiness.kind === 'dispose' && !row.disposal)
		await ctx.db.patch('contractOutputs', row._id, { disposal: true });
	const chunks = await ctx.db
		.query('contractOutputChunks')
		.withIndex('by_outputId_and_section_and_generation_and_order', (q) =>
			q.eq('outputId', outputId)
		)
		.take(8);
	for (const chunk of chunks) {
		if (chunk.companyId !== row.companyId || chunk.contractId !== row.contractId)
			throw new Error('Output fragment ownership changed.');
		await ctx.db.delete('contractOutputChunks', chunk._id);
	}
	if (chunks.length) return 'pending' as const;
	// Terminal deliveries no longer need an executable attempt reference. Provider facts stay factual.
	if (owners.event) await ctx.db.delete('hubspotEvents', owners.event._id);
	if (owners.delivery) await ctx.db.delete('hubspotExportDeliveries', owners.delivery._id);
	if (owners.attempt?.format === 'full' && readiness.kind === 'dispose')
		await ctx.db.delete('hubspotExports', owners.attempt._id);
	else if (owners.attempt?.format === 'full') {
		const {
			companyId,
			contractId,
			outputId,
			membershipId,
			profileId,
			createdAt,
			filename,
			sha256,
			size,
			releasedAt,
			acknowledgedAt,
			acknowledgedOn
		} = owners.attempt;
		await ctx.db.replace('hubspotExports', owners.attempt._id, {
			format: 'compact',
			state: 'expired',
			companyId,
			contractId,
			outputId,
			membershipId,
			profileId,
			createdAt,
			filename,
			sha256,
			size,
			releasedAt,
			acknowledgedAt,
			acknowledgedOn
		});
	}
	// Canonical reuse observes the old push; it never changes that push's original output owner.
	if (owners.push?.format === 'full' && owners.push.outputId === row._id) {
		const {
			companyId,
			contractId,
			outputId,
			destination,
			canonicalKey,
			fingerprint,
			payloadHash,
			state,
			updatedAt,
			settledAt,
			dispatchedAt,
			quoteId,
			previousQuoteId,
			url,
			message
		} = owners.push;
		if (
			(state !== 'verified' && state !== 'rejected' && state !== 'retired') ||
			settledAt === undefined
		)
			throw new Error('Unresolved provider compaction.');
		await ctx.db.replace('hubspotQuotePushes', owners.push._id, {
			format: 'compact',
			companyId,
			contractId,
			outputId,
			destination,
			canonicalKey,
			fingerprint,
			payloadHash,
			state,
			updatedAt,
			settledAt,
			dispatchedAt,
			quoteId,
			previousQuoteId,
			url,
			message
		});
	}
	if (readiness.kind === 'dispose') await ctx.db.delete('contractOutputs', row._id);
	else {
		if (!fact || row.settledAt === undefined || row.evidenceUntil === undefined)
			throw new Error('Missing historical output fact.');
		await ctx.db.replace('contractOutputs', row._id, {
			format: 'compact',
			companyId: row.companyId,
			contractId: row.contractId,
			kind: row.kind,
			state: 'complete',
			providerOperationId: row.providerOperationId,
			settledAt: row.settledAt,
			evidenceUntil: row.evidenceUntil,
			fact
		});
	}
	await releaseContractDocumentHold(ctx, row);
	return 'ready' as const;
}
