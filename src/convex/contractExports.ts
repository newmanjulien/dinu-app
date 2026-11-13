import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx
} from './_generated/server';
import { requireMembership } from './auth';
import { accessibleContractState, seller } from './contractState';
import { contractRenderTransport } from './contractValidators';
import { contractDocumentToRenderTransport } from '../lib/document/contract-document';
import {
	actionKey,
	receipt,
	remember,
	receiptPayload,
	sealReceipt,
	receiptSealWork
} from './operationReceipts';
import { exportRequest } from './savedContractValidators';
import schema from './schema';
import { reservedExport } from './documentExport';
import { currentSource, requireExpectedSource, staleSource } from './contractSource';
import { sourceExpectation } from './contractSourceValidators';
import { contractName } from '../lib/contract/filename';
import { deleteUnownedFile } from './storageOwnership';
import {
	captureExportDelivery,
	requireExportRelease,
	acknowledgeExportDelivery
} from './hubspotExportDeliveries';
import { cleanupBudget } from './cleanup';
import type { Doc, Id } from './_generated/dataModel';
import {
	advanceOutputProof,
	initialOutputPreparation,
	requireOutputFence,
	sealedManifest,
	outputReservation
} from './outputProof';
import { scheduleOutputPreparation } from './outputReservations';
import { queueOutputProofCleanup } from './outputProofCleanup';
import { authorizePreparedOperation, sellerPreparationActor } from './discussionPreparation';
import { documentBytes, assertStorageCapacity } from './storageCapacity';
import { EXPORT_HOUR as hour, EXPORT_READ_GRACE as READ_GRACE } from './exportRetention';

export const status = query({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts') },
	returns: v.object({
		expectedSource: sourceExpectation,
		canExport: v.boolean(),
		workBlock: v.union(v.null(), v.literal('association-required'), v.literal('deal-unavailable')),
		blockerCount: v.number()
	}),
	handler: async (ctx, args) => {
		const { source } = await currentSource(ctx, args);
		return {
			expectedSource: source.expectedSource,
			canExport: source.ready,
			workBlock: source.workBlock,
			blockerCount: source.blockerCount
		};
	}
});
async function activate(ctx: MutationCtx, row: Doc<'operationReceipts'>) {
	const { contract, access } = await authorizePreparedOperation(ctx, row),
		preparation = row.outputPreparation;
	if (
		!access ||
		row.state !== 'preparing' ||
		row.kind !== 'output-reservation' ||
		!preparation ||
		preparation.purpose !== 'reservation' ||
		preparation.phase !== 'sealed'
	)
		throw new Error('Invalid original Word reservation owner.');
	const payload = await receiptPayload(ctx, row),
		input: unknown = JSON.parse(payload.inputs);
	if (
		!Array.isArray(input) ||
		input.length !== 3 ||
		input[0] !== row.contractId ||
		input[1] !== 'word' ||
		actionKey(access, 'export', row.operationId!) !== row.key
	)
		throw new Error('Original Word reservation input changed.');
	await requireOutputFence(ctx, contract, preparation);
	const reservationManifest = sealedManifest(row, preparation),
		now = preparation.base.requestedAt;
	const timestamp = new Date(now).toISOString().slice(0, 19).replace('T', ' ').replaceAll(':', '-');
	const value = {
		key: row.key,
		inputs: payload.inputs,
		companyId: row.companyId,
		contractId: contract.root._id,
		reservationReceiptId: row._id,
		documentId: reservationManifest.documentId,
		membershipId: access.membershipId,
		profileId: reservationManifest.actor.profileId,
		createdAt: now,
		expiresAt: now + hour + READ_GRACE,
		state: 'preparing' as const,
		claim: preparation.claim!,
		filename: `${contractName(reservationManifest.title)} - ${timestamp}.docx`
	};
	// Reserve the complete owner/receipt/destination tail before its first business insert.
	const resultSize = JSON.stringify({ attemptId: 'x'.repeat(32), reservationManifest }),
		sealWork = await receiptSealWork(ctx, row, payload.inputs, resultSize);
	await assertStorageCapacity(ctx, {
		documents: sealWork.writes + 4,
		bytes:
			sealWork.bytes +
			documentBytes({ ...value, _id: 'x'.repeat(32), _creationTime: 0 }) +
			documentBytes({ ...row, reservationManifest, outputPreparation: undefined }) +
			32_768,
		queries: 12
	});
	const attemptId = await ctx.db.insert('hubspotExports', value);
	await captureExportDelivery(
		ctx,
		(await ctx.db.get('hubspotExports', attemptId))!,
		reservationManifest.destination.hubspot ?? undefined
	);
	await ctx.db.patch('operationReceipts', row._id, {
		reservationManifest,
		outputPreparation: undefined
	});
	await sealReceipt(ctx, row, payload.inputs, {
		state: 'complete',
		result: JSON.stringify({ attemptId, reservationManifest })
	});
	return (await ctx.db.get('hubspotExports', attemptId))!;
}
export const activatePrepared = internalMutation({
	args: { receiptId: v.id('operationReceipts') },
	returns: v.null(),
	handler: async (ctx, { receiptId }) => {
		const row = await ctx.db.get('operationReceipts', receiptId);
		if (row?.state === 'preparing') await activate(ctx, row);
		return null;
	}
});
const reserveResult = v.union(
	v.object({ status: v.literal('preparing'), receiptId: v.id('operationReceipts') }),
	v.object({ status: v.literal('reserved'), attempt: schema.doc('hubspotExports') })
);
export const reserve = internalMutation({
	args: exportRequest.extend({ operationId: v.string(), claim: v.string() }).fields,
	returns: reserveResult,
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId),
			key = actionKey(access, 'export', args.operationId),
			inputs = JSON.stringify([args.id, 'word', args.expectedSource]);
		const committed = await receipt(ctx, key, inputs);
		if (committed?.state === 'failed')
			throw new ConvexError(
				committed.error ?? 'This output preparation failed. Start a new download.'
			);
		if (committed?.state === 'preparing') {
			await scheduleOutputPreparation(ctx, committed);
			return { status: 'preparing' as const, receiptId: committed._id };
		}
		const prior = await ctx.db
			.query('hubspotExports')
			.withIndex('by_key', (q) => q.eq('key', key))
			.unique();
		if (prior) {
			if (
				!committed ||
				prior.inputs !== inputs ||
				JSON.parse(committed.result).attemptId !== prior._id ||
				prior.reservationReceiptId !== committed._id
			)
				throw new ConvexError('This download attempt was already used.');
			await outputReservation(ctx, prior);
			if (
				prior.state === 'preparing' &&
				prior.createdAt + hour > Date.now() &&
				prior.createdAt + 2 * 60_000 < Date.now()
			) {
				await ctx.db.patch('hubspotExports', prior._id, { claim: args.claim });
				return { status: 'reserved' as const, attempt: { ...prior, claim: args.claim } };
			}
			return { status: 'reserved' as const, attempt: prior };
		}
		if (committed)
			throw new ConvexError('This download attempt is unavailable. Start a new download.');
		const { contract } = await seller(ctx, args);
		requireExpectedSource(contract, args.expectedSource);
		const preparation = await initialOutputPreparation(ctx, contract, access, 'reservation', 0);
		preparation.claim = args.claim;
		const receiptId = await remember(
			ctx,
			access.companyId,
			key,
			inputs,
			'',
			{
				contractId: args.id,
				documentId: contract.root.documentId,
				kind: 'output-reservation',
				requestedAt: preparation.base.requestedAt
			},
			{
				actor: sellerPreparationActor(access),
				operationId: args.operationId,
				outputPreparation: preparation
			}
		);
		const row = (await ctx.db.get('operationReceipts', receiptId))!,
			progress = await advanceOutputProof(ctx, row, contract, true),
			live = (await ctx.db.get('operationReceipts', receiptId))!;
		if (progress.phase === 'sealed')
			return { status: 'reserved' as const, attempt: await activate(ctx, live) };
		await scheduleOutputPreparation(ctx, live);
		return { status: 'preparing' as const, receiptId };
	}
});
export const content = internalQuery({
	args: { id: v.id('hubspotExports'), claim: v.string() },
	returns: v.object({ document: contractRenderTransport, title: v.string() }),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx),
			attempt = await ctx.db.get('hubspotExports', args.id);
		if (
			!attempt ||
			attempt.companyId !== access.companyId ||
			attempt.membershipId !== access.membershipId ||
			attempt.profileId !== access.profile._id ||
			attempt.claim !== args.claim ||
			attempt.state !== 'preparing' ||
			attempt.createdAt + hour <= Date.now()
		)
			throw new ConvexError('This download attempt is unavailable. Start a new download.');
		const { document, reservationManifest } = await reservedExport(ctx, attempt);
		return {
			document: contractDocumentToRenderTransport(document),
			title: reservationManifest.title
		};
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
		const access = await requireMembership(ctx),
			attempt = await ctx.db.get('hubspotExports', args.id);
		if (
			!attempt ||
			attempt.companyId !== access.companyId ||
			attempt.membershipId !== access.membershipId ||
			attempt.profileId !== access.profile._id ||
			attempt.claim !== args.claim ||
			attempt.state !== 'preparing' ||
			attempt.createdAt + hour <= Date.now()
		)
			throw new ConvexError('This download attempt expired. Start a new download.');
		await outputReservation(ctx, attempt);
		await ctx.db.patch('hubspotExports', attempt._id, {
			fileId: args.fileId,
			sha256: args.sha256,
			size: args.size,
			state: 'ready'
		});
		return null;
	}
});
export const prepareRelease = internalMutation({
	args: { id: v.id('hubspotExports') },
	returns: v.object({ complete: v.boolean(), receiptId: v.id('operationReceipts') }),
	handler: async (ctx, { id }) => {
		const access = await requireMembership(ctx),
			attempt = await ctx.db.get('hubspotExports', id);
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
		const { owner } = await outputReservation(ctx, attempt),
			current = await accessibleContractState(ctx, attempt.contractId, access);
		if (!current) throw new ConvexError('This contract was deleted.');
		await authorizePreparedOperation(ctx, owner);
		let preparation = owner.outputPreparation;
		if (preparation?.purpose === 'release') {
			try {
				await requireOutputFence(ctx, current, preparation);
			} catch {
				await ctx.db.patch('operationReceipts', owner._id, { outputPreparation: undefined });
				await queueOutputProofCleanup(ctx, owner._id, preparation.generation);
				preparation = undefined;
			}
		}
		if (!preparation) {
			const generation = (owner.outputGeneration ?? 0) + 1;
			preparation = await initialOutputPreparation(ctx, current, access, 'release', generation);
			await ctx.db.patch('operationReceipts', owner._id, {
				outputPreparation: preparation,
				outputGeneration: generation
			});
		}
		if (preparation.phase !== 'sealed')
			preparation = await advanceOutputProof(
				ctx,
				{ ...owner, outputPreparation: preparation },
				current,
				true
			);
		if (preparation.phase !== 'sealed')
			await scheduleOutputPreparation(ctx, (await ctx.db.get('operationReceipts', owner._id))!);
		return { complete: preparation.phase === 'sealed', receiptId: owner._id };
	}
});
export const release = internalMutation({
	args: { id: v.id('hubspotExports') },
	returns: v.object({ url: v.string(), filename: v.string(), attemptId: v.id('hubspotExports') }),
	handler: async (ctx, { id }) => {
		const access = await requireMembership(ctx),
			attempt = await ctx.db.get('hubspotExports', id);
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
		const current = await accessibleContractState(ctx, attempt.contractId, access);
		if (!current) throw new ConvexError('This contract was deleted.');
		const { owner, reservationManifest } = await outputReservation(ctx, attempt),
			proof = owner.outputPreparation;
		if (!proof || proof.purpose !== 'release' || proof.phase !== 'sealed')
			throw new ConvexError('This download is still being checked. Try again shortly.');
		await requireOutputFence(ctx, current, proof);
		if (proof.identity !== reservationManifest.identity) throw staleSource();
		await requireExportRelease(ctx, attempt, current);
		const url = await ctx.storage.getUrl(attempt.fileId);
		if (!url) throw new ConvexError('This download is unavailable. Start a new download.');
		await ctx.db.patch('hubspotExports', id, { releasedAt: attempt.releasedAt ?? Date.now() });
		await ctx.db.patch('operationReceipts', owner._id, { outputPreparation: undefined });
		await queueOutputProofCleanup(ctx, owner._id, proof.generation);
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
		const expiresAt = await acknowledgeExportDelivery(ctx, attempt, args.initiatedAt, now);
		await ctx.db.patch('hubspotExports', attempt._id, {
			acknowledgedAt: args.initiatedAt,
			acknowledgedOn: now,
			expiresAt
		});
		return null;
	}
});
export const expire = internalMutation({
	args: {
		state: v.optional(v.union(v.literal('preparing'), v.literal('ready'))),
		cutoff: v.optional(v.number()),
		cursor: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const cutoff = args.cutoff ?? Date.now();
		const state = args.state ?? 'preparing';
		const page = await ctx.db
			.query('hubspotExports')
			.withIndex('by_state_and_expiresAt', (q) => q.eq('state', state).lte('expiresAt', cutoff))
			.paginate({
				cursor: args.cursor ?? null,
				numItems: 20,
				maximumRowsRead: 20,
				maximumBytesRead: 1024 * 1024
			});
		for (const attempt of page.page) {
			const owner = await ctx.db.get('operationReceipts', attempt.reservationReceiptId);
			if (owner?.outputPreparation?.purpose === 'release') {
				if (owner.companyId !== attempt.companyId || owner.contractId !== attempt.contractId)
					throw new Error('Expired output proof ownership changed.');
				const generation = owner.outputPreparation.generation;
				await ctx.db.patch('operationReceipts', owner._id, { outputPreparation: undefined });
				await queueOutputProofCleanup(ctx, owner._id, generation);
			}
			await ctx.db.patch('hubspotExports', attempt._id, { state: 'expired', fileId: undefined });
			if (attempt.fileId) await deleteUnownedFile(ctx, attempt.fileId);
		}
		if (!page.isDone)
			await ctx.scheduler.runAfter(0, internal.contractExports.expire, {
				state,
				cutoff,
				cursor: page.continueCursor
			});
		else if (state === 'preparing')
			await ctx.scheduler.runAfter(0, internal.contractExports.expire, { state: 'ready', cutoff });
		return null;
	}
});

/** Core attempt/provenance lifetime is the company, independent of contract and provider lifetimes. */
export async function cleanupCompanyExports(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	{ drain } = cleanupBudget(ctx)
) {
	if (
		!(await drain(
			'hubspotExports',
			ctx.db.query('hubspotExports').withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
			{
				afterDelete: async (attempt) => {
					if (attempt.fileId) await deleteUnownedFile(ctx, attempt.fileId);
				}
			}
		))
	)
		return false;
	return true;
}
