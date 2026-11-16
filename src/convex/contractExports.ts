import { settleOutput, finishOutputFileDeletion } from './outputLifecycle';
import { exportAttempt } from './exportValidators';
import type { FullOutput } from './outputLifecycle';
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
	admitOperation,
	operationExpired,
	receipt,
	remember,
	receiptPayload,
	sealReceipt,
	receiptSealWork
} from './operationReceipts';
import { exportRequest } from './savedContractValidators';
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
import type { Id } from './_generated/dataModel';
import {
	advanceOutputProof,
	initialOutputPreparation,
	requireOutputFence,
	sealedManifest,
	outputManifestHash,
	outputReservation
} from './outputProof';
import {
	createOutput,
	outputReceipt,
	retireOutputPreparation,
	scheduleOutputPreparation
} from './outputReservations';
import { queueOutputProofCleanup } from './outputProofCleanup';
import { authorizePreparedOperation, sellerPreparationActor } from './discussionPreparation';
import { documentBytes, assertStorageCapacity } from './storageCapacity';
import {
	EXPORT_HOUR as hour,
	EXPORT_READ_GRACE as READ_GRACE,
	EXPORT_ACKNOWLEDGEMENT_WINDOW
} from './exportRetention';

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
async function activate(ctx: MutationCtx, row: FullOutput) {
	admitOperation(row.operationId!);
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
	const original = await outputReceipt(ctx, row),
		payload = await receiptPayload(ctx, original),
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
		format: 'full' as const,
		key: row.key,
		inputs: payload.inputs,
		companyId: row.companyId,
		contractId: contract.root._id,
		outputId: row._id,
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
	const resultSize = JSON.stringify({ attemptId: 'x'.repeat(32), outputId: row._id }),
		sealWork = await receiptSealWork(ctx, original, payload.inputs, resultSize);
	await assertStorageCapacity(ctx, {
		documents: sealWork.writes + 4,
		bytes:
			sealWork.bytes +
			documentBytes({ ...value, _id: 'x'.repeat(32), _creationTime: 0 }) +
			documentBytes({
				...row,
				reservationManifest,
				manifestHash: outputManifestHash(reservationManifest),
				outputPreparation: undefined,
				state: 'complete',
				receiptId: undefined
			}) +
			32_768,
		queries: 12
	});
	const attemptId = await ctx.db.insert('hubspotExports', value);
	const attempt = await ctx.db.get('hubspotExports', attemptId);
	if (attempt?.format !== 'full') throw new Error('Invalid Word attempt owner.');
	await captureExportDelivery(ctx, attempt, reservationManifest.destination.hubspot ?? undefined);
	await ctx.db.patch('contractOutputs', row._id, {
		reservationManifest,
		manifestHash: outputManifestHash(reservationManifest),
		outputPreparation: undefined,
		state: 'complete',
		receiptId: undefined
	});
	await sealReceipt(ctx, original, payload.inputs, {
		state: 'complete',
		result: JSON.stringify({ attemptId, outputId: row._id })
	});
	return attempt;
}
export const activatePrepared = internalMutation({
	args: { outputId: v.id('contractOutputs') },
	returns: v.null(),
	handler: async (ctx, { outputId }) => {
		const row = await ctx.db.get('contractOutputs', outputId);
		if (row?.format === 'full' && row.state === 'preparing') {
			if (operationExpired(row))
				await retireOutputPreparation(
					ctx,
					row,
					'This operation expired. Review the preserved intent against the current contract.',
					'OPERATION_EXPIRED'
				);
			else await activate(ctx, row);
		}
		return null;
	}
});
const reserveResult = v.union(
	v.object({ status: v.literal('preparing'), outputId: v.id('contractOutputs') }),
	v.object({
		status: v.literal('reserved'),
		attempt: exportAttempt.extend({ _id: v.id('hubspotExports'), _creationTime: v.number() })
	})
);
export const reserve = internalMutation({
	args: exportRequest.extend({ operationId: v.string(), claim: v.string() }).fields,
	returns: reserveResult,
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		admitOperation(args.operationId);
		const key = actionKey(access, 'export', args.operationId),
			inputs = JSON.stringify([args.id, 'word', args.expectedSource]);
		const committed = await receipt(ctx, key, inputs);
		if (committed?.state === 'failed')
			throw new ConvexError(
				committed.error ?? 'This output preparation failed. Start a new download.'
			);
		if (committed?.state === 'preparing') {
			const output = committed.outputId
				? await ctx.db.get('contractOutputs', committed.outputId)
				: null;
			if (!output || output.format !== 'full')
				throw new Error('Missing private Word output owner.');
			await scheduleOutputPreparation(ctx, output);
			return { status: 'preparing' as const, outputId: output._id };
		}
		const prior = await ctx.db
			.query('hubspotExports')
			.withIndex('by_key', (q) => q.eq('key', key))
			.unique();
		if (prior) {
			if (prior.format !== 'full') throw new ConvexError('This download attempt expired.');
			if (
				!committed ||
				prior.inputs !== inputs ||
				JSON.parse(committed.result).attemptId !== prior._id ||
				prior.outputId !== committed.outputId ||
				JSON.parse(committed.result).outputId !== prior.outputId
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
				kind: 'output-reservation'
			},
			{
				actor: sellerPreparationActor(access),
				operationId: args.operationId
			}
		);
		const row = await createOutput(ctx, receiptId, preparation, 'output-reservation'),
			progress = await advanceOutputProof(ctx, row, contract, true),
			live = { ...row, outputPreparation: progress };
		if (progress.phase === 'sealed')
			return { status: 'reserved' as const, attempt: await activate(ctx, live) };
		await scheduleOutputPreparation(ctx, live);
		return { status: 'preparing' as const, outputId: row._id };
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
			attempt.format !== 'full' ||
			attempt.companyId !== access.companyId ||
			attempt.membershipId !== access.membershipId ||
			attempt.profileId !== access.profile._id ||
			attempt.claim !== args.claim ||
			attempt.state !== 'preparing'
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
			attempt.format !== 'full' ||
			attempt.companyId !== access.companyId ||
			attempt.membershipId !== access.membershipId ||
			attempt.profileId !== access.profile._id ||
			attempt.claim !== args.claim ||
			attempt.state !== 'preparing' ||
			attempt.createdAt + hour <= Date.now()
		)
			throw new ConvexError('This download attempt expired. Start a new download.');
		const { owner } = await outputReservation(ctx, attempt);
		admitOperation(owner.operationId!);
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
	returns: v.object({ complete: v.boolean(), outputId: v.id('contractOutputs') }),
	handler: async (ctx, { id }) => {
		const access = await requireMembership(ctx),
			attempt = await ctx.db.get('hubspotExports', id);
		if (
			!attempt ||
			attempt.format !== 'full' ||
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
		admitOperation(owner.operationId!);
		await authorizePreparedOperation(ctx, owner);
		let preparation = owner.outputPreparation;
		if (preparation?.purpose === 'release') {
			try {
				await requireOutputFence(ctx, current, preparation);
			} catch {
				await ctx.db.patch('contractOutputs', owner._id, { outputPreparation: undefined });
				await queueOutputProofCleanup(ctx, owner._id, preparation.generation);
				preparation = undefined;
			}
		}
		if (!preparation) {
			const generation = (owner.outputGeneration ?? 0) + 1;
			preparation = await initialOutputPreparation(ctx, current, access, 'release', generation);
			await ctx.db.patch('contractOutputs', owner._id, {
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
			await scheduleOutputPreparation(ctx, { ...owner, outputPreparation: preparation });
		return { complete: preparation.phase === 'sealed', outputId: owner._id };
	}
});
export const release = internalMutation({
	args: { id: v.id('hubspotExports') },
	returns: v.object({
		url: v.string(),
		filename: v.string(),
		attemptId: v.id('hubspotExports'),
		releasedAt: v.number()
	}),
	handler: async (ctx, { id }) => {
		const access = await requireMembership(ctx),
			attempt = await ctx.db.get('hubspotExports', id);
		if (
			!attempt ||
			attempt.format !== 'full' ||
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
		admitOperation(owner.operationId!);
		if (!proof || proof.purpose !== 'release' || proof.phase !== 'sealed')
			throw new ConvexError('This download is still being checked. Try again shortly.');
		await requireOutputFence(ctx, current, proof);
		if (proof.identity !== reservationManifest.identity) throw staleSource();
		await requireExportRelease(ctx, attempt, current);
		const url = await ctx.storage.getUrl(attempt.fileId);
		if (!url) throw new ConvexError('This download is unavailable. Start a new download.');
		const releasedAt = attempt.releasedAt ?? Date.now();
		await ctx.db.patch('hubspotExports', id, { releasedAt });
		await ctx.db.patch('contractOutputs', owner._id, { outputPreparation: undefined });
		await queueOutputProofCleanup(ctx, owner._id, proof.generation);
		await settleOutput(ctx, owner._id);
		return { url, filename: attempt.filename, attemptId: id, releasedAt };
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
		if (
			attempt.format !== 'full' ||
			Date.now() >= attempt.releasedAt + EXPORT_ACKNOWLEDGEMENT_WINDOW
		)
			throw new ConvexError({
				code: 'DOWNLOAD_ACK_TERMINAL',
				message: 'The download acknowledgement window closed.'
			});
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
			if (attempt.format !== 'full') continue;
			const owner = await ctx.db.get('contractOutputs', attempt.outputId);
			if (owner?.format === 'full' && owner.outputPreparation?.purpose === 'release') {
				if (owner.companyId !== attempt.companyId || owner.contractId !== attempt.contractId)
					throw new Error('Expired output proof ownership changed.');
				const generation = owner.outputPreparation.generation;
				await ctx.db.patch('contractOutputs', owner._id, { outputPreparation: undefined });
				await queueOutputProofCleanup(ctx, owner._id, generation);
			}
			await ctx.db.patch('hubspotExports', attempt._id, {
				state: 'expired',
				fileId: undefined,
				deletingFileId: attempt.fileId ?? attempt.deletingFileId
			});
			await finishOutputFileDeletion(ctx, {
				...attempt,
				fileId: undefined,
				deletingFileId: attempt.fileId ?? attempt.deletingFileId
			});
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
					if (attempt.format === 'full')
						for (const fileId of [attempt.fileId, attempt.deletingFileId])
							if (fileId) await deleteUnownedFile(ctx, fileId);
				}
			}
		))
	)
		return false;
	return true;
}
