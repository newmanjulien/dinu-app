import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, mutation, type MutationCtx } from './_generated/server';
import { accessibleContract, requireMembership } from './auth';
import { actionKey, actorOf, activity } from './hubspotRecords';
import { exportRequest } from './savedContractValidators';
import schema from './schema';
import { snapshotReader } from './templates';
import { concessionSelections } from '../lib/contract/applications';
import { savedReviews } from '../lib/contract/approval';
import { baselineBlock } from '../lib/contract/source-validators';
import { historicalItem } from './playbookValidators';
import { contractName } from '../lib/contract/export/content';
import { deleteUnownedFile } from './storageOwnership';
import { installation, requireContractWork } from './contractPolicy';

import { encodeProvenance, decodeProvenance, provenanceChunks } from './hubspotProvenance';
const hour = 60 * 60_000;
// Physical cleanup lag, not extra release/upload eligibility. Covers the bounded sender's reads.
const READ_GRACE = 15 * 60_000;
export function retainedUntil(attempt: DocExport) {
	return Math.max(
		attempt.createdAt + hour,
		attempt.remoteFileId ? 0 : (attempt.attachmentUntil ?? 0)
	);
}
export async function confirmUpload(ctx: MutationCtx, id: DocExport['_id'], remoteFileId: string) {
	const attempt = await ctx.db.get('hubspotExports', id);
	if (!attempt) return;
	await ctx.db.patch('hubspotExports', id, {
		remoteFileId,
		attachmentUntil: undefined,
		expiresAt: Math.max(attempt.createdAt + hour, Date.now()) + READ_GRACE
	});
}

export const reserve = internalMutation({
	args: exportRequest.extend({ operationId: v.string(), claim: v.string() }).fields,
	returns: schema.doc('hubspotExports'),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId),
			key = actionKey(access, 'export', args.operationId),
			inputs = JSON.stringify([args.id, args.expectedEditRevision]);
		const prior = await ctx.db
			.query('hubspotExports')
			.withIndex('by_key', (q) => q.eq('key', key))
			.unique();
		if (prior) {
			if (prior.inputs !== inputs) throw new ConvexError('This download attempt was already used.');
			if (
				prior.state === 'preparing' &&
				prior.createdAt + hour > Date.now() &&
				prior.createdAt + 2 * 60_000 < Date.now()
			) {
				await ctx.db.patch('hubspotExports', prior._id, { claim: args.claim });
				return { ...prior, claim: args.claim };
			}
			return prior;
		}
		const contract = accessibleContract(await ctx.db.get('savedContracts', args.id), access);
		if (!contract) throw new ConvexError('This contract was deleted.');
		await requireContractWork(ctx, contract);
		if (contract.editRevision !== args.expectedEditRevision)
			throw new ConvexError('This contract changed. Wait for the saved version.');
		const reader = await snapshotReader(ctx, contract),
			items = await reader.selectedItems(concessionSelections(contract.applications));
		if (savedReviews(items, contract).some((r) => r.status !== 'approved'))
			throw new ConvexError('All selected concessions must be approved before downloading.');
		const now = Date.now(),
			timestamp = new Date(now).toISOString().slice(0, 19).replace('T', ' ').replaceAll(':', '-');
		const { availability: _availability, ...destination } = contract.hubspot ?? {
			availability: 'available'
		};
		const id = await ctx.db.insert('hubspotExports', {
			key,
			inputs,
			companyId: access.companyId,
			contractId: contract._id,
			membershipId: access.membershipId,
			profileId: access.profile._id,
			actor: actorOf(access.profile),
			destination: contract.hubspot
				? (destination as NonNullable<DocExport['destination']>)
				: undefined,
			title: contract.buyerCompanyName,
			templateVersionId: contract.templateVersionId,
			editRevision: contract.editRevision,
			reviewGeneration: contract.reviewGeneration,
			createdAt: now,
			expiresAt: now + hour + READ_GRACE,
			provenance: 'tuple-v1',
			state: 'preparing',
			claim: args.claim,
			filename: `${contractName(contract.buyerCompanyName)} - ${timestamp}.docx`
		});
		const chunks = provenanceChunks(encodeProvenance(contract.applications));
		for (let order = 0; order < chunks.length; order++)
			await ctx.db.insert('hubspotExportChunks', {
				companyId: access.companyId,
				attemptId: id,
				order,
				data: chunks[order]
			});
		return (await ctx.db.get('hubspotExports', id))!;
	}
});
type DocExport = import('./_generated/dataModel').Doc<'hubspotExports'>;
export const content = internalQuery({
	args: { id: v.id('hubspotExports'), claim: v.string() },
	returns: v.object({
		blocks: v.array(baselineBlock),
		items: v.array(historicalItem),
		applications: schema.doc('savedContracts').pick('applications').fields.applications,
		title: v.string()
	}),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx);
		const attempt = await ctx.db.get('hubspotExports', args.id);
		if (
			!attempt ||
			attempt.companyId !== access.companyId ||
			attempt.membershipId !== access.membershipId ||
			attempt.claim !== args.claim ||
			attempt.state !== 'preparing' ||
			attempt.createdAt + hour <= Date.now()
		)
			throw new ConvexError('This download attempt is unavailable. Start a new download.');
		const current = accessibleContract(
			await ctx.db.get('savedContracts', attempt.contractId),
			access
		);
		if (!current) throw new ConvexError('This contract was deleted.');
		const chunks = await ctx.db
			.query('hubspotExportChunks')
			.withIndex('by_attemptId_and_order', (q) => q.eq('attemptId', attempt._id))
			.take(64);
		if (chunks.length === 64) throw new Error('Download provenance exceeds its storage envelope.');
		const applications = decodeProvenance(chunks.map((c) => c.data).join(''));
		const reader = await snapshotReader(ctx, {
			...current,
			templateVersionId: attempt.templateVersionId
		});
		const [blocks, items] = await Promise.all([
			reader.blocks(),
			reader.selectedItems(concessionSelections(applications))
		]);
		return { blocks, items, applications, title: attempt.title };
	}
});
export const publish = internalMutation({
	args: {
		id: v.id('hubspotExports'),
		claim: v.string(),
		fileId: v.id('_storage'),
		sha256: v.string(),
		size: v.number()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx);
		const attempt = await ctx.db.get('hubspotExports', args.id);
		if (
			!attempt ||
			attempt.companyId !== access.companyId ||
			attempt.membershipId !== access.membershipId ||
			attempt.claim !== args.claim ||
			attempt.state !== 'preparing' ||
			attempt.createdAt + hour <= Date.now()
		)
			throw new ConvexError('This download attempt expired. Start a new download.');
		await ctx.db.patch('hubspotExports', attempt._id, {
			fileId: args.fileId,
			sha256: args.sha256,
			size: args.size,
			state: 'ready'
		});
		return null;
	}
});
export const release = internalMutation({
	args: { id: v.id('hubspotExports') },
	returns: v.object({ url: v.string(), filename: v.string(), attemptId: v.id('hubspotExports') }),
	handler: async (ctx, { id }) => {
		const access = await requireMembership(ctx);
		const attempt = await ctx.db.get('hubspotExports', id);
		if (
			!attempt ||
			attempt.companyId !== access.companyId ||
			attempt.membershipId !== access.membershipId ||
			attempt.profileId !== access.profile._id ||
			attempt.state !== 'ready' ||
			!attempt.fileId ||
			attempt.createdAt + hour <= Date.now()
		)
			throw new ConvexError('This download attempt expired. Start a new download.');
		const current = accessibleContract(
			await ctx.db.get('savedContracts', attempt.contractId),
			access
		);
		if (
			!current ||
			current.editRevision !== attempt.editRevision ||
			current.reviewGeneration !== attempt.reviewGeneration ||
			current.templateVersionId !== attempt.templateVersionId
		)
			throw new ConvexError('This contract changed. Start a new download.');
		// A pre-install attempt cannot acquire a destination from a later association.
		if (!attempt.destination && (await installation(ctx, current.companyId)))
			throw new ConvexError({
				code: 'DOWNLOAD_ATTEMPT_RETIRED',
				message:
					'HubSpot was installed after this download started. Start a new download after linking a deal.'
			});
		await requireContractWork(ctx, current);
		const url = await ctx.storage.getUrl(attempt.fileId);
		if (!url) throw new ConvexError('This download is unavailable. Start a new download.');
		await ctx.db.patch('hubspotExports', id, { releasedAt: attempt.releasedAt ?? Date.now() });
		return { url, filename: attempt.filename, attemptId: id };
	}
});
export const acknowledge = mutation({
	args: { membershipId: v.id('memberships'), id: v.string(), initiatedAt: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const id = ctx.db.normalizeId('hubspotExports', args.id);
		if (!id)
			throw new ConvexError({
				code: 'DOWNLOAD_ACK_TERMINAL',
				message: 'Invalid download attempt.'
			});
		const attempt = await ctx.db.get('hubspotExports', id);
		if (
			!attempt ||
			attempt.companyId !== access.companyId ||
			attempt.membershipId !== access.membershipId ||
			attempt.profileId !== access.profile._id ||
			!attempt.releasedAt
		)
			throw new ConvexError('This download is unavailable.');
		if (attempt.acknowledgedAt !== undefined) return null;
		if (!Number.isFinite(args.initiatedAt) || args.initiatedAt < attempt.releasedAt - 60_000)
			throw new ConvexError({
				code: 'DOWNLOAD_ACK_TERMINAL',
				message: 'Invalid download acknowledgment.'
			});
		if (args.initiatedAt > Date.now() + 60_000)
			throw new ConvexError({
				code: 'DOWNLOAD_ACK_FUTURE',
				retryAfter: Math.min(24 * hour, args.initiatedAt - Date.now() - 60_000),
				message: 'Download acknowledgment is in the future.'
			});
		const now = Date.now();
		const available = Boolean(attempt.fileId && retainedUntil(attempt) > now);
		const attachmentUntil =
			attempt.destination && available && !attempt.remoteFileId ? now + 30 * 24 * hour : undefined;
		await ctx.db.patch('hubspotExports', attempt._id, {
			acknowledgedAt: args.initiatedAt,
			acknowledgedOn: now,
			attachmentUntil,
			expiresAt: Math.max(attempt.createdAt + hour, attachmentUntil ?? 0) + READ_GRACE
		});
		if (attempt.destination) {
			// Captured destination deliberately survives relinking or contract deletion.
			const synthetic = {
				_id: attempt.contractId,
				companyId: attempt.companyId,
				buyerCompanyName: attempt.title,
				hubspot: { ...attempt.destination, availability: 'available' as const }
			};
			await activity(
				ctx,
				synthetic,
				attempt.actor,
				attempt.key,
				'downloaded',
				JSON.stringify({
					filename: attempt.filename,
					sha256: attempt.sha256 ?? null,
					attachmentAvailable: Boolean(available || attempt.remoteFileId)
				}),
				args.initiatedAt,
				attempt._id
			);
		}
		return null;
	}
});
export const expire = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		for (const state of ['preparing', 'ready'] as const) {
			const attempts = await ctx.db
				.query('hubspotExports')
				.withIndex('by_state_and_expiresAt', (q) =>
					q.eq('state', state).lte('expiresAt', Date.now())
				)
				.take(20);
			for (const attempt of attempts) {
				await ctx.db.patch('hubspotExports', attempt._id, { state: 'expired', fileId: undefined });
				if (attempt.fileId) await deleteUnownedFile(ctx, attempt.fileId);
			}
		}
		return null;
	}
});
