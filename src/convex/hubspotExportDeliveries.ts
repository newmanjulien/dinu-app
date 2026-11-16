import { ConvexError } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { activity } from './hubspotRecords';
import { outputReservation } from './outputProof';
import { installation, requireContractWork } from './contractPolicy';
import { EXPORT_HOUR, EXPORT_READ_GRACE, retainedUntil } from './exportRetention';
import type { Infer } from 'convex/values';
import type { hubspotExportDelivery } from './hubspotExportDeliveryValidators';

type Attempt = import('./outputLifecycle').FullExportAttempt;
type Delivery = Infer<typeof hubspotExportDelivery>;

/** Indexed operational delivery state; immutable destination also lives on its output. */
export async function exportDelivery(ctx: QueryCtx, attempt: Doc<'hubspotExports'>) {
	const row = await ctx.db
		.query('hubspotExportDeliveries')
		.withIndex('by_attemptId', (q) => q.eq('attemptId', attempt._id))
		.unique();
	if (row && row.companyId !== attempt.companyId)
		throw new Error('Export delivery ownership is invalid.');
	return row;
}

export async function captureExportDelivery(
	ctx: MutationCtx,
	attempt: Attempt,
	destination: Delivery['destination'] | undefined
) {
	if (destination)
		await ctx.db.insert('hubspotExportDeliveries', {
			companyId: attempt.companyId,
			attemptId: attempt._id,
			destination
		});
}

export async function requireExportRelease(
	ctx: QueryCtx,
	attempt: Attempt,
	current: Parameters<typeof requireContractWork>[1]
) {
	const delivery = await exportDelivery(ctx, attempt);
	if (!delivery && (await installation(ctx, attempt.companyId)))
		throw new ConvexError({
			code: 'DOWNLOAD_ATTEMPT_RETIRED',
			message:
				'HubSpot was installed after this download started. Start a new download after linking a deal.'
		});
	const captured = delivery
		? await ctx.db.get('hubspotConnections', delivery.destination.connectionId)
		: null;
	const retired = delivery && (!captured || captured.status === 'retiring');
	if (!retired) await requireContractWork(ctx, current);
}

/** Actor and destination were captured before release and remain valid after contract deletion. */
export async function acknowledgeExportDelivery(
	ctx: MutationCtx,
	attempt: Attempt,
	initiatedAt: number,
	now: number
) {
	const { reservationManifest } = await outputReservation(ctx, attempt);
	const delivery = await exportDelivery(ctx, attempt);
	if (!delivery) return attempt.createdAt + EXPORT_HOUR + EXPORT_READ_GRACE;
	const available = Boolean(attempt.fileId && retainedUntil(attempt, delivery) > now);
	const active = await activity(
		ctx,
		{
			root: {
				_id: attempt.contractId,
				companyId: attempt.companyId,
				title: reservationManifest.title
			},
			hubspot: { ...delivery.destination, availability: 'available' as const }
		},
		{ name: reservationManifest.actor.name, email: reservationManifest.actor.email },
		attempt.key,
		'downloaded',
		JSON.stringify({
			outputId: attempt.outputId,
			documentId: attempt.documentId ?? null,
			filename: attempt.filename,
			sha256: attempt.sha256 ?? null,
			attachmentAvailable: Boolean(available || delivery.remoteFileId)
		}),
		initiatedAt,
		attempt._id
	);
	const attachmentUntil =
		active && available && !delivery.remoteFileId ? now + 30 * 24 * EXPORT_HOUR : undefined;
	await ctx.db.patch('hubspotExportDeliveries', delivery._id, { attachmentUntil });
	return Math.max(attempt.createdAt + EXPORT_HOUR, attachmentUntil ?? 0) + EXPORT_READ_GRACE;
}

export async function confirmUpload(ctx: MutationCtx, id: Attempt['_id'], remoteFileId: string) {
	const attempt = await ctx.db.get('hubspotExports', id);
	if (!attempt || attempt.format !== 'full') return;
	const delivery = await exportDelivery(ctx, attempt);
	if (!delivery) return;
	await ctx.db.patch('hubspotExportDeliveries', delivery._id, {
		remoteFileId,
		attachmentUntil: undefined
	});
	await ctx.db.patch('hubspotExports', id, {
		expiresAt: Math.max(attempt.createdAt + EXPORT_HOUR, Date.now()) + EXPORT_READ_GRACE
	});
}

/** Shared uninstall path retires entitlement while preserving the original local release window. */
export async function retireExportDelivery(
	ctx: MutationCtx,
	delivery: Doc<'hubspotExportDeliveries'>
) {
	if (delivery.attachmentUntil === undefined) return;
	await ctx.db.patch('hubspotExportDeliveries', delivery._id, { attachmentUntil: undefined });
	const attempt = await ctx.db.get('hubspotExports', delivery.attemptId);
	if (attempt?.format === 'full')
		await ctx.db.patch('hubspotExports', attempt._id, {
			expiresAt: Math.max(attempt.createdAt + EXPORT_HOUR, Date.now()) + EXPORT_READ_GRACE
		});
}
