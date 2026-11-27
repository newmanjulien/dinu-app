import { ConvexError, v } from 'convex/values';
import { approvedConcessionMap, contractReadiness } from '../lib/contract/changes';
import { contractName } from '../lib/contract/filename';
import { sourceBlock } from '../lib/document/source-validators';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import { appliedOverlay } from './buyerValidators';
import { cleanupBudget } from './cleanup';
import { requireContractWork } from './contractPolicy';
import { seller } from './contractState';
import { wordExportRequest } from './exportValidators';
import {
	EXPORT_READ_GRACE_MS,
	EXPORT_TTL_MS,
	recordExportDelivery
} from './hubspotExportDeliveries';
import { actionKey, actorOf, validateOperationId } from './operationReceipts';
import { wordExportResult } from './savedContractValidators';
import { deleteUnownedFile } from './storageOwnership';
import { readAppliedOverlays, snapshotReader } from './templates';

const prepareResult = v.union(
	v.object({
		kind: v.literal('existing'),
		url: v.string(),
		filename: v.string(),
		downloadExpiresAt: v.number()
	}),
	v.object({
		kind: v.literal('generate'),
		title: v.string(),
		templateVersionId: v.id('templateVersions'),
		stateRevision: v.number(),
		blocks: v.array(sourceBlock),
		appliedOverlays: v.array(appliedOverlay),
		concessions: v.record(v.id('playbookItems'), v.string())
	})
);

export const prepare = internalQuery({
	args: wordExportRequest.fields,
	returns: prepareResult,
	handler: async (ctx, args) => {
		const { access, contract } = await seller(ctx, args);
		validateOperationId(args.operationId);
		const key = actionKey(access, 'export', args.operationId);
		const prior = await ctx.db
			.query('wordExports')
			.withIndex('by_key', (q) => q.eq('key', key))
			.unique();
		if (prior) {
			if (
				prior.companyId !== access.companyId ||
				prior.contractId !== args.id ||
				prior.membershipId !== access.membershipId ||
				prior.profileId !== access.profile._id
			)
				throw new ConvexError('This download attempt is unavailable.');
			if (!prior.fileId)
				throw new ConvexError('This download attempt expired. Start a new download.');
			const url = await ctx.storage.getUrl(prior.fileId);
			if (!url) throw new ConvexError('This download attempt expired. Start a new download.');
			return {
				kind: 'existing' as const,
				url,
				filename: prior.filename,
				downloadExpiresAt: prior.createdAt + EXPORT_TTL_MS
			};
		}

		await requireContractWork(ctx, contract);
		if (contract.root.stateRevision !== args.expectedStateRevision)
			throw new ConvexError(
				'The saved contract changed. Review the current contract and try again.'
			);
		if (!contractReadiness(contract.root.concessions).ready)
			throw new ConvexError('Approve or remove pending concessions before downloading.');

		const concessions = approvedConcessionMap(contract.root.concessions);
		const reader = await snapshotReader(ctx, contract.root);
		const [blocks, appliedOverlays] = await Promise.all([
			reader.blocks(),
			readAppliedOverlays(reader, concessions)
		]);
		return {
			kind: 'generate' as const,
			title: contract.root.title,
			templateVersionId: contract.root.templateVersionId,
			stateRevision: contract.root.stateRevision,
			blocks,
			appliedOverlays,
			concessions
		};
	}
});

export const commit = internalMutation({
	args: {
		...wordExportRequest.fields,
		fileId: v.id('_storage'),
		sha256: v.string(),
		size: v.number(),
		expectedTemplateVersionId: v.id('templateVersions'),
		expectedTitle: v.string()
	},
	returns: wordExportResult,
	handler: async (ctx, args) => {
		const { access, contract } = await seller(ctx, args);
		validateOperationId(args.operationId);
		const key = actionKey(access, 'export', args.operationId);
		const prior = await ctx.db
			.query('wordExports')
			.withIndex('by_key', (q) => q.eq('key', key))
			.unique();
		if (prior) {
			if (
				prior.companyId !== access.companyId ||
				prior.contractId !== args.id ||
				prior.membershipId !== access.membershipId ||
				prior.profileId !== access.profile._id
			)
				throw new ConvexError('This download attempt is unavailable.');
			if (!prior.fileId || prior.createdAt + EXPORT_TTL_MS <= Date.now())
				throw new ConvexError('This download attempt expired. Start a new download.');
			const url = await ctx.storage.getUrl(prior.fileId);
			if (!url) throw new ConvexError('This download attempt expired. Start a new download.');
			await deleteUnownedFile(ctx, args.fileId);
			return { url, filename: prior.filename };
		}

		await requireContractWork(ctx, contract);
		if (
			contract.root.templateVersionId !== args.expectedTemplateVersionId ||
			contract.root.stateRevision !== args.expectedStateRevision ||
			contract.root.title !== args.expectedTitle
		)
			throw new ConvexError('The saved contract changed. Start a new download.');
		if (!contractReadiness(contract.root.concessions).ready)
			throw new ConvexError('Approve or remove pending concessions before downloading.');

		const now = Date.now();
		const timestamp = new Date(now)
			.toISOString()
			.slice(0, 19)
			.replace('T', ' ')
			.replaceAll(':', '-');
		const filename = `${contractName(contract.root.title)} - ${timestamp}.docx`;
		const initialExpiresAt = now + EXPORT_TTL_MS + EXPORT_READ_GRACE_MS;
		const value = {
			companyId: access.companyId,
			contractId: contract.root._id,
			templateVersionId: contract.root.templateVersionId,
			title: contract.root.title,
			actor: actorOf(access.profile),
			membershipId: access.membershipId,
			profileId: access.profile._id,
			key,
			createdAt: now,
			expiresAt: initialExpiresAt,
			fileId: args.fileId,
			filename,
			sha256: args.sha256,
			size: args.size
		};
		const attemptId = await ctx.db.insert('wordExports', value);
		const attempt = (await ctx.db.get('wordExports', attemptId))!;
		const expiresAt = await recordExportDelivery(ctx, attempt, contract, now);
		if (expiresAt !== initialExpiresAt) {
			await ctx.db.patch('wordExports', attemptId, { expiresAt });
		}
		const url = await ctx.storage.getUrl(args.fileId);
		if (!url) throw new ConvexError('This download is unavailable. Start a new download.');
		return { url, filename };
	}
});

/** Expire stored DOCX bytes once their local download and HubSpot attachment windows end. */
export const expire = internalMutation({
	args: {
		cutoff: v.optional(v.number()),
		cursor: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const cutoff = args.cutoff ?? Date.now();
		const page = await ctx.db
			.query('wordExports')
			.withIndex('by_expiresAt', (q) => q.gt('expiresAt', 0).lte('expiresAt', cutoff))
			.paginate({
				cursor: args.cursor ?? null,
				numItems: 20,
				maximumRowsRead: 20,
				maximumBytesRead: 1024 * 1024
			});
		for (const attempt of page.page) {
			const fileToDelete = attempt.fileId;
			await ctx.db.patch('wordExports', attempt._id, {
				fileId: undefined,
				expiresAt: undefined
			});
			if (fileToDelete) await deleteUnownedFile(ctx, fileToDelete);
		}
		if (!page.isDone)
			await ctx.scheduler.runAfter(0, internal.contractExports.expire, {
				cutoff,
				cursor: page.continueCursor
			});
		return null;
	}
});

/** Company erasure removes every Word export record and releases its storage bytes. */
export async function cleanupCompanyExports(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	{ drain } = cleanupBudget(ctx)
) {
	return drain(
		'wordExports',
		ctx.db.query('wordExports').withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
		{
			afterDelete: async (attempt) => {
				if (attempt.fileId) await deleteUnownedFile(ctx, attempt.fileId);
			}
		}
	);
}
