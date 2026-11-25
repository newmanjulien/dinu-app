import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Contract } from './contractState';
import { activity } from './hubspotRecords';

export const EXPORT_TTL_MS = 60 * 60_000;
export const EXPORT_READ_GRACE_MS = 15 * 60_000;
export const EXPORT_ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function retainedUntil(
	attempt: Doc<'wordExports'>,
	delivery: Doc<'hubspotExportDeliveries'> | null
) {
	return Math.max(attempt.createdAt + EXPORT_TTL_MS, delivery?.attachmentUntil ?? 0);
}

/** Indexed operational delivery state for HubSpot download attachment uploads. */
export async function exportDelivery(ctx: QueryCtx, attempt: Doc<'wordExports'>) {
	const row = await ctx.db
		.query('hubspotExportDeliveries')
		.withIndex('by_attemptId', (q) => q.eq('attemptId', attempt._id))
		.unique();
	if (row && row.companyId !== attempt.companyId)
		throw new Error('Export delivery ownership is invalid.');
	return row;
}

/** Record HubSpot download timeline activity and attachment retention atomically on commit. */
export async function recordExportDelivery(
	ctx: MutationCtx,
	attempt: Doc<'wordExports'>,
	contract: Contract,
	now: number
) {
	const baseExpiry = attempt.createdAt + EXPORT_TTL_MS + EXPORT_READ_GRACE_MS;
	if (!contract.hubspot) return baseExpiry;
	const { availability: _availability, ...destination } = contract.hubspot;
	const active = await activity(
		ctx,
		{
			root: {
				_id: attempt.contractId,
				companyId: attempt.companyId,
				title: attempt.title
			},
			hubspot: contract.hubspot
		},
		attempt.actor,
		attempt.key,
		'downloaded',
		JSON.stringify({
			filename: attempt.filename,
			sha256: attempt.sha256,
			attachmentAvailable: Boolean(attempt.fileId)
		}),
		now,
		attempt._id
	);
	if (!active) return baseExpiry;
	const attachmentUntil = attempt.fileId ? now + EXPORT_ATTACHMENT_RETENTION_MS : undefined;
	await ctx.db.insert('hubspotExportDeliveries', {
		companyId: attempt.companyId,
		attemptId: attempt._id,
		destination,
		...(attachmentUntil !== undefined ? { attachmentUntil } : {})
	});
	return Math.max(attempt.createdAt + EXPORT_TTL_MS, attachmentUntil ?? 0) + EXPORT_READ_GRACE_MS;
}

export async function confirmUpload(
	ctx: MutationCtx,
	id: Doc<'wordExports'>['_id'],
	remoteFileId: string
) {
	const attempt = await ctx.db.get('wordExports', id);
	if (!attempt) return;
	const delivery = await exportDelivery(ctx, attempt);
	if (!delivery) return;
	await ctx.db.patch('hubspotExportDeliveries', delivery._id, {
		remoteFileId,
		attachmentUntil: undefined
	});
	if (attempt.fileId !== undefined) {
		await ctx.db.patch('wordExports', id, {
			expiresAt: Math.max(attempt.createdAt + EXPORT_TTL_MS, Date.now()) + EXPORT_READ_GRACE_MS
		});
	}
}

/** Shared uninstall path retires HubSpot attachment retention while preserving local download window. */
export async function retireExportDelivery(
	ctx: MutationCtx,
	delivery: Doc<'hubspotExportDeliveries'>
) {
	if (delivery.attachmentUntil === undefined) return;
	await ctx.db.patch('hubspotExportDeliveries', delivery._id, { attachmentUntil: undefined });
	const attempt = await ctx.db.get('wordExports', delivery.attemptId);
	if (attempt?.fileId !== undefined) {
		await ctx.db.patch('wordExports', attempt._id, {
			expiresAt: Math.max(attempt.createdAt + EXPORT_TTL_MS, Date.now()) + EXPORT_READ_GRACE_MS
		});
	}
}
