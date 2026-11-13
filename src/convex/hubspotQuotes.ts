import { ConvexError, v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import {
	env,
	internalMutation,
	internalQuery,
	query,
	mutation,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import { accessibleContract, availableCompany, liveCompanyMember, requireMembership } from './auth';
import { readContract, seller, type Contract } from './contractState';
import { contractRenderTransport } from './contractValidators';
import { contractDocumentToRenderTransport } from '../lib/document/contract-document';
import { installation, requireContractWork } from './contractPolicy';
import { reservedExport } from './documentExport';
import { requireExpectedSource, staleSource } from './contractSource';
import { quoteInstallationFor } from './hubspotQuotesInstallation';
import {
	hasQuoteScopes,
	quoteSummary,
	quoteProviderFailure,
	quoteRunningUntil,
	quoteRequest,
	quoteReservation
} from './hubspotQuoteValidators';
import { pool } from './hubspotDelivery';
import {
	receipt,
	receiptPayload,
	remember,
	actionKey,
	sealReceipt,
	receiptSealWork
} from './operationReceipts';
import { deleteUnownedFile } from './storageOwnership';
import schema from './schema';
import { hubspotErrorIdentifier } from './hubspotApi';
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
import { canonicalJson } from '../lib/document/canonical-json';

type Push = Doc<'hubspotQuotePushes'>;
type Reservation = Infer<typeof quoteReservation>;
type Request = Infer<typeof quoteRequest> & { operationId: string };
const requestArgs = quoteRequest.extend({ operationId: v.string() });
const summary = (row: Push) => ({
	id: row._id,
	state: row.state,
	canonicalKey: row.canonicalKey,
	url: row.url ?? null,
	message: row.message ?? null
});
const retention = 30 * 24 * 60 * 60_000;
const sameDestination = (a: Request['destination'], b: Request['destination']) =>
	a.connectionId === b.connectionId &&
	a.accountId === b.accountId &&
	a.dealId === b.dealId &&
	a.generation === b.generation;
const requestInputs = (args: Request) =>
	JSON.stringify([args.id, 'hubspot-quote', args.expectedSource, args.destination]);

async function requireQuotes(ctx: QueryCtx, contract: Contract) {
	const connection = await requireContractWork(ctx, contract),
		quotes = await quoteInstallationFor(ctx, contract.root.companyId);
	if (!connection || connection.status !== 'connected')
		throw new ConvexError('Reconnect HubSpot before pushing this contract.');
	if (
		!quotes?.enabled ||
		quotes.connectionId !== connection._id ||
		quotes.accountId !== connection.accountId
	)
		throw new ConvexError('Ask an admin to install HubSpot Quotes.');
	if (!hasQuoteScopes(connection.scopes))
		throw new ConvexError('Ask an admin to reconnect HubSpot Quotes.');
	if (
		env.HUBSPOT_ENABLED !== 'true' ||
		env.HUBSPOT_QUOTES_ENABLED !== 'true' ||
		env.HUBSPOT_QUOTES_PUSH_ENABLED !== 'true'
	)
		throw new ConvexError('Pushing to HubSpot Quotes is temporarily unavailable.');
	const { availability, ...destination } = contract.hubspot!;
	return { connection, quotes, destination };
}
/** The immutable owner identifies the real actor and original installation/deal. */
async function gated(ctx: QueryCtx, reservation: Reservation) {
	const { companyId, contractId, membershipId, actor, destination } = reservation;
	if (
		!(await availableCompany(ctx, companyId)) ||
		!(await liveCompanyMember(ctx, companyId, actor.profileId))
	)
		return null;
	const member = await ctx.db.get('memberships', membershipId),
		root = await ctx.db.get('savedContracts', contractId);
	if (
		!member ||
		member.profileId !== actor.profileId ||
		member.companyId !== companyId ||
		!root ||
		root.companyId !== companyId ||
		(await ctx.db
			.query('contractCleanups')
			.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
			.unique())
	)
		return null;
	try {
		const contract = await readContract(ctx, root),
			access = await requireQuotes(ctx, contract);
		if (
			access.quotes._id !== destination.installationId ||
			access.quotes.epoch !== destination.epoch ||
			!destination.hubspot ||
			!sameDestination(access.destination, destination.hubspot)
		)
			return null;
		return { ...access, contract };
	} catch {
		return null;
	}
}
async function requireQuoteFence(ctx: QueryCtx, row: Doc<'operationReceipts'>, contract: Contract) {
	const preparation = row.outputPreparation;
	if (!preparation) throw new Error('Missing Quote proof preparation.');
	const access = await requireQuotes(ctx, contract),
		destination = preparation.fence.destination;
	if (
		!destination.hubspot ||
		destination.installationId !== access.quotes._id ||
		destination.epoch !== access.quotes.epoch ||
		destination.connectionGeneration !== access.connection.generation ||
		!sameDestination(destination.hubspot, access.destination)
	)
		throw new ConvexError(
			'The contract access or linked HubSpot deal changed. Prepare a new push.'
		);
	await requireOutputFence(ctx, contract, preparation);
	return access.connection;
}
export const checkPrepared = internalMutation({
	args: { receiptId: v.id('operationReceipts') },
	returns: v.null(),
	handler: async (ctx, { receiptId }) => {
		const row = await ctx.db.get('operationReceipts', receiptId);
		if (!row || row.kind !== 'quote-reservation') throw new Error('Invalid Quote receipt.');
		const { contract } = await authorizePreparedOperation(ctx, row);
		await requireQuoteFence(ctx, row, contract);
		return null;
	}
});
async function activate(ctx: MutationCtx, row: Doc<'operationReceipts'>) {
	const { contract, access } = await authorizePreparedOperation(ctx, row),
		preparation = row.outputPreparation;
	if (
		!access ||
		row.state !== 'preparing' ||
		row.kind !== 'quote-reservation' ||
		!preparation ||
		preparation.purpose !== 'reservation' ||
		preparation.phase !== 'sealed'
	)
		throw new Error('Invalid original Quote reservation owner.');
	const payload = await receiptPayload(ctx, row),
		input: unknown = JSON.parse(payload.inputs);
	if (
		!Array.isArray(input) ||
		input.length !== 4 ||
		input[0] !== row.contractId ||
		input[1] !== 'hubspot-quote' ||
		actionKey(access, 'quote-reservation', row.operationId!) !== row.key
	)
		throw new Error('Original Quote reservation input changed.');
	await requireQuoteFence(ctx, row, contract);
	const reservationManifest = sealedManifest(row, preparation),
		result = JSON.stringify(reservationManifest),
		work = await receiptSealWork(ctx, row, payload.inputs, result);
	await assertStorageCapacity(ctx, {
		documents: work.writes + 1,
		bytes:
			work.bytes +
			documentBytes({ ...row, reservationManifest, outputPreparation: undefined }) +
			16_384,
		queries: 8
	});
	await ctx.db.patch('operationReceipts', row._id, {
		reservationManifest,
		outputPreparation: undefined
	});
	await sealReceipt(ctx, row, payload.inputs, { state: 'complete', result });
	return reservationManifest;
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
async function reserved(ctx: QueryCtx, args: Request) {
	const access = await requireMembership(ctx, args.membershipId),
		key = actionKey(access, 'quote-reservation', args.operationId),
		row = await receipt(ctx, key, requestInputs(args));
	if (
		!row ||
		row.kind !== 'quote-reservation' ||
		row.companyId !== access.companyId ||
		row.contractId !== args.id ||
		row.state !== 'complete' ||
		!row.documentId
	)
		throw new ConvexError('This push reservation is unavailable. Prepare a new push.');
	const { reservationManifest: reservation } = await outputReservation(ctx, {
		companyId: access.companyId,
		contractId: args.id,
		reservationReceiptId: row._id,
		documentId: row.documentId
	});
	if (
		reservation.membershipId !== access.membershipId ||
		reservation.actor.profileId !== access.profile._id ||
		canonicalJson(JSON.parse(row.result)) !== canonicalJson(reservation)
	)
		throw new Error('Invalid push reservation ownership.');
	return { access, key, reservation, owner: row };
}
async function committed(ctx: QueryCtx, args: Request, reservation: Reservation) {
	const access = await requireMembership(ctx, args.membershipId),
		stored = await ctx.db
			.query('operationReceipts')
			.withIndex('by_key', (q) => q.eq('key', actionKey(access, 'quote', args.operationId)))
			.unique();
	if (!stored) return null;
	if (
		stored.kind !== 'quote-commit' ||
		stored.companyId !== access.companyId ||
		stored.contractId !== args.id ||
		stored.documentId !== reservation.documentId
	)
		throw new ConvexError('This push operation was already used.');
	const payload = await receiptPayload(ctx, stored),
		id = ctx.db.normalizeId('hubspotQuotePushes', payload.result),
		push = id ? await ctx.db.get('hubspotQuotePushes', id) : null;
	if (
		!push ||
		push.companyId !== access.companyId ||
		push.contractId !== args.id ||
		stored.providerOperationId !== push._id
	)
		throw new ConvexError('This push result is unavailable.');
	return summary(push);
}
/** Exact retries keep the original owner, inputs, actor, destination and proof. */
export const reserve = internalMutation({
	args: requestArgs.fields,
	returns: v.union(
		v.object({ kind: v.literal('preparing'), receiptId: v.id('operationReceipts') }),
		v.object({ kind: v.literal('reserved'), reservation: quoteReservation }),
		v.object({ kind: v.literal('committed'), summary: quoteSummary })
	),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		if (!/^[\w-]{1,100}$/u.test(args.operationId)) throw new ConvexError('Invalid push operation.');
		const key = actionKey(access, 'quote-reservation', args.operationId),
			inputs = requestInputs(args),
			prior = await receipt(ctx, key, inputs);
		if (prior?.state === 'failed')
			throw new ConvexError(prior.error ?? 'This push preparation failed. Prepare a new push.');
		if (prior?.state === 'preparing') {
			await scheduleOutputPreparation(ctx, prior);
			return { kind: 'preparing' as const, receiptId: prior._id };
		}
		if (prior) {
			const { reservation } = await reserved(ctx, args),
				result = await committed(ctx, args, reservation);
			return result
				? { kind: 'committed' as const, summary: result }
				: { kind: 'reserved' as const, reservation };
		}
		const { contract } = await seller(ctx, args);
		requireExpectedSource(contract, args.expectedSource);
		const { quotes, connection, destination } = await requireQuotes(ctx, contract);
		if (!sameDestination(args.destination, destination))
			throw new ConvexError('The linked HubSpot deal changed. Prepare a new push.');
		const latest = await ctx.db
			.query('operationReceipts')
			.withIndex('by_contractId_and_kind_and_requestedAt', (q) =>
				q.eq('contractId', args.id).eq('kind', 'quote-reservation')
			)
			.order('desc')
			.first();
		const preparation = await initialOutputPreparation(ctx, contract, access, 'reservation', 0, {
			hubspot: args.destination,
			connectionGeneration: connection.generation,
			installationId: quotes._id,
			epoch: quotes.epoch
		});
		preparation.base.requestedAt = Math.max(Date.now(), (latest?.requestedAt ?? 0) + 1);
		const receiptId = await remember(
			ctx,
			access.companyId,
			key,
			inputs,
			'',
			{
				contractId: args.id,
				documentId: contract.root.documentId,
				kind: 'quote-reservation',
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
			return { kind: 'reserved' as const, reservation: await activate(ctx, live) };
		await scheduleOutputPreparation(ctx, live);
		return { kind: 'preparing' as const, receiptId };
	}
});
export const content = internalQuery({
	args: requestArgs.fields,
	returns: v.object({ source: quoteReservation, document: contractRenderTransport }),
	handler: async (ctx, args) => {
		const { reservation, owner } = await reserved(ctx, args),
			{ document } = await reservedExport(ctx, {
				companyId: reservation.companyId,
				contractId: reservation.contractId,
				reservationReceiptId: owner._id,
				documentId: reservation.documentId
			});
		return { source: reservation, document: contractDocumentToRenderTransport(document) };
	}
});
/** Current-source proof is another generation on the same original operation owner. */
async function prepareCurrent(ctx: MutationCtx, owner: Doc<'operationReceipts'>) {
	const { contract, access } = await authorizePreparedOperation(ctx, owner);
	if (!access || !owner.reservationManifest || !(await gated(ctx, owner.reservationManifest)))
		throw new ConvexError(
			'The contract access or linked HubSpot deal changed. Prepare a new push.'
		);
	let preparation = owner.outputPreparation;
	if (preparation) {
		if (preparation.purpose !== 'release')
			throw new Error('Invalid Quote current-source proof purpose.');
		try {
			await requireQuoteFence(ctx, owner, contract);
		} catch {
			await ctx.db.patch('operationReceipts', owner._id, { outputPreparation: undefined });
			await queueOutputProofCleanup(ctx, owner._id, preparation.generation);
			preparation = undefined;
		}
	}
	if (!preparation) {
		const { connection, quotes, destination } = await requireQuotes(ctx, contract),
			generation = (owner.outputGeneration ?? 0) + 1;
		preparation = await initialOutputPreparation(ctx, contract, access, 'release', generation, {
			hubspot: destination,
			connectionGeneration: connection.generation,
			installationId: quotes._id,
			epoch: quotes.epoch
		});
		await ctx.db.patch('operationReceipts', owner._id, {
			outputPreparation: preparation,
			outputGeneration: generation
		});
	}
	if (preparation.phase !== 'sealed')
		preparation = await advanceOutputProof(
			ctx,
			{ ...owner, outputPreparation: preparation },
			contract,
			true
		);
	if (preparation.phase !== 'sealed')
		await scheduleOutputPreparation(ctx, (await ctx.db.get('operationReceipts', owner._id))!);
	return preparation.phase === 'sealed';
}
async function authorized(ctx: QueryCtx, row: Push) {
	try {
		const { owner, reservationManifest } = await outputReservation(ctx, row),
			access = await gated(ctx, reservationManifest),
			preparation = owner.outputPreparation;
		if (
			!access ||
			!preparation ||
			preparation.purpose !== 'release' ||
			preparation.phase !== 'sealed' ||
			preparation.identity !== reservationManifest.identity
		)
			return null;
		await authorizePreparedOperation(ctx, owner);
		return await requireQuoteFence(ctx, owner, access.contract);
	} catch {
		return null;
	}
}
export const prepareCommit = internalMutation({
	args: requestArgs.fields,
	returns: v.object({ complete: v.boolean(), receiptId: v.id('operationReceipts') }),
	handler: async (ctx, args) => {
		const { owner } = await reserved(ctx, args);
		return { complete: await prepareCurrent(ctx, owner), receiptId: owner._id };
	}
});
export const prepareDispatch = internalMutation({
	args: { id: v.id('hubspotQuotePushes'), claim: v.string(), generation: v.number() },
	returns: v.object({ complete: v.boolean(), receiptId: v.id('operationReceipts') }),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotQuotePushes', args.id);
		if (
			!row ||
			row.state !== 'queued' ||
			row.claim !== args.claim ||
			(row.leaseUntil ?? 0) <= Date.now()
		)
			throw new ConvexError('This push lease expired.');
		const { owner, reservationManifest } = await outputReservation(ctx, row),
			access = await gated(ctx, reservationManifest);
		if (!access || access.connection.generation !== args.generation)
			throw new ConvexError('The HubSpot credentials changed.');
		return { complete: await prepareCurrent(ctx, owner), receiptId: owner._id };
	}
});
/** Commit immutable bytes and provider identity; reused pushes retain their first owner. */
export const commit = internalMutation({
	args: requestArgs.extend({
		fileId: v.optional(v.id('_storage')),
		fingerprint: v.string(),
		payloadHash: v.string(),
		canonicalKey: v.string()
	}).fields,
	returns: v.union(
		v.object({ kind: v.literal('reused'), summary: quoteSummary }),
		v.object({ kind: v.literal('payload-required') }),
		v.object({ kind: v.literal('preparing'), receiptId: v.id('operationReceipts') })
	),
	handler: async (ctx, args) => {
		const { access, key: reservationKey, reservation, owner } = await reserved(ctx, args);
		if (
			![args.fingerprint, args.payloadHash, args.canonicalKey].every((value) =>
				/^[a-f0-9]{64}$/u.test(value)
			)
		)
			throw new ConvexError('Invalid immutable push payload.');
		const key = actionKey(access, 'quote', args.operationId),
			inputs = JSON.stringify([
				reservationKey,
				owner._id,
				args.canonicalKey,
				args.fingerprint,
				args.payloadHash
			]),
			priorCommit = await receipt(ctx, key, inputs);
		if (priorCommit) {
			const result = await committed(ctx, args, reservation);
			if (!result) throw new Error('Missing committed push result.');
			return { kind: 'reused' as const, summary: result };
		}
		if (
			!owner.outputVerification?.complete ||
			owner.outputVerification.generation !== reservation.proof.generation
		)
			throw new ConvexError({
				code: 'OUTPUT_PENDING',
				message: 'This push evidence is still being checked. Try again shortly.'
			});
		const current = await gated(ctx, reservation),
			fresh = owner.outputPreparation;
		if (!current)
			throw new ConvexError(
				'The contract access or linked HubSpot deal changed. Prepare a new push.'
			);
		if (!fresh || fresh.purpose !== 'release' || fresh.phase !== 'sealed')
			return { kind: 'preparing' as const, receiptId: owner._id };
		await requireQuoteFence(ctx, owner, current.contract);
		if (fresh.identity !== reservation.identity) throw staleSource();
		let prior: Push | null = null;
		for (const state of [
			'unknown',
			'dispatched',
			'verifying',
			'verified',
			'attention',
			'queued'
		] as const) {
			const candidate = await ctx.db
				.query('hubspotQuotePushes')
				.withIndex('by_canonicalKey_and_state', (q) =>
					q.eq('canonicalKey', args.canonicalKey).eq('state', state)
				)
				.order('desc')
				.first();
			if (!candidate) continue;
			if (
				candidate.companyId !== access.companyId ||
				candidate.contractId !== args.id ||
				candidate.fingerprint !== args.fingerprint ||
				candidate.destination.accountId !== reservation.destination.hubspot!.accountId ||
				candidate.destination.dealId !== reservation.destination.hubspot!.dealId
			)
				throw new Error('Invalid quote deduplication identity.');
			if (state !== 'queued') {
				prior = candidate;
				break;
			}
			try {
				const existing = await outputReservation(ctx, candidate);
				if (!(await prepareCurrent(ctx, existing.owner)))
					return { kind: 'preparing' as const, receiptId: existing.owner._id };
				if (await authorized(ctx, candidate)) {
					prior = candidate;
					break;
				}
			} catch {
				/* An unsent obsolete reservation can be stopped after its running lease. */
			}
			if (quoteRunningUntil(candidate) > Date.now())
				throw new ConvexError('This push is still stopping. Wait a moment, then push again.');
			await stop(
				ctx,
				candidate,
				'The reserved authorization changed before sending. Prepare a new push.'
			);
		}
		if (!prior && !args.fileId) return { kind: 'payload-required' as const };
		const now = Date.now(),
			id =
				prior?._id ??
				(await ctx.db.insert('hubspotQuotePushes', {
					companyId: reservation.companyId,
					contractId: reservation.contractId,
					reservationReceiptId: owner._id,
					documentId: reservation.documentId,
					destination: reservation.destination.hubspot!,
					canonicalKey: args.canonicalKey,
					fingerprint: args.fingerprint,
					payloadHash: args.payloadHash,
					state: 'queued',
					updatedAt: now,
					fileId: args.fileId!,
					payloadExpiresAt: now + retention,
					readAttempts: 0,
					dueAt: now
				}));
		await remember(ctx, access.companyId, key, inputs, id, {
			contractId: args.id,
			documentId: reservation.documentId,
			kind: 'quote-commit',
			providerOperationId: id,
			requestedAt: reservation.requestedAt
		});
		if (prior) {
			await ctx.db.patch('operationReceipts', owner._id, { outputPreparation: undefined });
			await queueOutputProofCleanup(ctx, owner._id, fresh.generation);
		} else await ctx.scheduler.runAfter(0, internal.hubspotQuotes.pump, {});
		return {
			kind: 'reused' as const,
			summary: summary((await ctx.db.get('hubspotQuotePushes', id))!)
		};
	}
});

export const latest = query({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		pushId: v.optional(v.id('hubspotQuotePushes'))
	},
	returns: v.union(quoteSummary, v.null()),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		if (!accessibleContract(await ctx.db.get('savedContracts', args.id), access)) return null;
		let row = args.pushId ? await ctx.db.get('hubspotQuotePushes', args.pushId) : null;
		if (!args.pushId) {
			const latest = await ctx.db
				.query('operationReceipts')
				.withIndex('by_contractId_and_kind_and_requestedAt', (q) =>
					q.eq('contractId', args.id).eq('kind', 'quote-commit')
				)
				.order('desc')
				.first();
			if (latest && latest.companyId === access.companyId) {
				const value = await receiptPayload(ctx, latest);
				const id = ctx.db.normalizeId('hubspotQuotePushes', value.result);
				row = id ? await ctx.db.get('hubspotQuotePushes', id) : null;
			}
		}
		return row?.companyId === access.companyId && row.contractId === args.id ? summary(row) : null;
	}
});

/** Retire only work proven unsent, or stop readback while preserving its known quote. */
async function clearCurrent(ctx: MutationCtx, row: Push) {
	const owner = await ctx.db.get('operationReceipts', row.reservationReceiptId);
	const proof = owner?.outputPreparation;
	if (owner && (owner.companyId !== row.companyId || owner.contractId !== row.contractId))
		throw new Error('Quote proof cleanup ownership changed.');
	if (owner && proof?.purpose === 'release') {
		await ctx.db.patch('operationReceipts', owner._id, { outputPreparation: undefined });
		await queueOutputProofCleanup(ctx, owner._id, proof.generation);
	}
}
async function stop(ctx: MutationCtx, row: Push, message: string) {
	await clearCurrent(ctx, row);
	if (row.workId) await pool.cancel(ctx, row.workId as import('@convex-dev/workpool').WorkId);
	await ctx.db.patch('hubspotQuotePushes', row._id, {
		state: row.quoteId ? 'attention' : 'retired',
		message,
		claim: undefined,
		workId: undefined,
		leaseUntil: undefined,
		dueAt: undefined,
		updatedAt: Date.now()
	});
}

export const pump = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		for (const state of ['queued', 'dispatched', 'verifying'] as const) {
			const rows = await ctx.db
				.query('hubspotQuotePushes')
				.withIndex('by_state_and_dueAt', (q) => q.eq('state', state).lte('dueAt', now))
				.take(20);
			for (const row of rows) {
				const metrics = await ctx.meta.getTransactionMetrics();
				if (
					metrics.bytesRead.remaining < 3_000_000 ||
					metrics.bytesWritten.remaining < 1_500_000 ||
					metrics.databaseQueries.remaining < 100 ||
					metrics.documentsRead.remaining < 100 ||
					metrics.documentsWritten.remaining < 40 ||
					metrics.functionsScheduled.remaining < 8
				) {
					await ctx.scheduler.runAfter(0, internal.hubspotQuotes.pump, {});
					return null;
				}
				if (quoteRunningUntil(row) > now) continue;
				if (state === 'dispatched') {
					// Retain the claim so truthful late settlement can still record a returned ID.
					await ctx.db.patch('hubspotQuotePushes', row._id, {
						state: 'unknown',
						dueAt: undefined,
						updatedAt: now,
						message:
							'HubSpot may have created this quote. Contact Dinu support before pushing this version again.'
					});
					continue;
				}
				if (state === 'queued' && row.fileId && (row.payloadExpiresAt ?? 0) > now) {
					try {
						const { owner } = await outputReservation(ctx, row);
						if (!(await prepareCurrent(ctx, owner))) {
							await ctx.db.patch('hubspotQuotePushes', row._id, { dueAt: now + 1000 });
							await ctx.scheduler.runAfter(1000, internal.hubspotQuotes.pump, {});
							continue;
						}
					} catch {
						await stop(
							ctx,
							row,
							'The reserved authorization changed before sending. Prepare a new push.'
						);
						continue;
					}
				}
				if (
					!row.fileId ||
					(row.payloadExpiresAt ?? 0) <= now ||
					(state === 'queued' && !(await authorized(ctx, row)))
				) {
					await stop(
						ctx,
						row,
						'This push stopped before sending. Check the saved contract and integration, then push again.'
					);
					continue;
				}
				if (row.workId && !row.leaseUntil) {
					const status = await pool.status(
						ctx,
						row.workId as import('@convex-dev/workpool').WorkId
					);
					if (status.state !== 'finished') {
						await ctx.db.patch('hubspotQuotePushes', row._id, { dueAt: now + 60_000 });
						continue;
					}
				}
				if (row.workId) await pool.cancel(ctx, row.workId as import('@convex-dev/workpool').WorkId);
				const claim = crypto.randomUUID();
				const workId = await pool.enqueueAction(
					ctx,
					internal.hubspotQuoteActions.send,
					{ id: row._id, claim },
					{ retry: false }
				);
				await ctx.db.patch('hubspotQuotePushes', row._id, {
					claim,
					workId,
					leaseUntil: undefined,
					dueAt: now + 60_000
				});
			}
		}
		return null;
	}
});

/** Queue time consumes none of the running allowance. Duplicate/stale starts do nothing. */
export const start = internalMutation({
	args: { id: v.id('hubspotQuotePushes'), claim: v.string() },
	returns: v.union(
		v.object({
			push: schema.doc('hubspotQuotePushes'),
			connection: schema.doc('hubspotConnections'),
			title: v.string()
		}),
		v.null()
	),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotQuotePushes', args.id);
		if (
			!row ||
			row.claim !== args.claim ||
			row.leaseUntil !== undefined ||
			!['queued', 'verifying'].includes(row.state)
		)
			return null;
		if (row.state === 'queued' && !(await authorized(ctx, row))) {
			try {
				const { owner } = await outputReservation(ctx, row);
				if (!(await prepareCurrent(ctx, owner))) {
					await ctx.db.patch('hubspotQuotePushes', row._id, { dueAt: Date.now() + 1000 });
					await ctx.scheduler.runAfter(1000, internal.hubspotQuotes.pump, {});
					return null;
				}
			} catch {
				await stop(
					ctx,
					row,
					'The reserved authorization changed before sending. Prepare a new push.'
				);
				return null;
			}
		}
		const connection =
			row.state === 'queued'
				? await authorized(ctx, row)
				: (await availableCompany(ctx, row.companyId))
					? await installation(ctx, row.companyId)
					: null;
		if (
			!row.fileId ||
			(row.payloadExpiresAt ?? 0) <= Date.now() ||
			!connection ||
			connection.accountId !== row.destination.accountId ||
			connection.status !== 'connected' ||
			!hasQuoteScopes(connection.scopes)
		) {
			await stop(
				ctx,
				row,
				'The integration, contract or retained verification bytes are unavailable. Review any existing quote in HubSpot.'
			);
			return null;
		}
		const leaseUntil = Date.now() + 90_000;
		await ctx.db.patch('hubspotQuotePushes', row._id, { leaseUntil, dueAt: leaseUntil + 30_000 });
		const { reservationManifest } = await outputReservation(ctx, row);
		return { push: { ...row, leaseUntil }, connection, title: reservationManifest.title };
	}
});

export const dispatch = internalMutation({
	args: { id: v.id('hubspotQuotePushes'), claim: v.string(), generation: v.number() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotQuotePushes', args.id);
		const connection = row ? await authorized(ctx, row) : null;
		if (
			!row ||
			row.state !== 'queued' ||
			row.dispatchedAt !== undefined ||
			row.claim !== args.claim ||
			(row.leaseUntil ?? 0) <= Date.now() ||
			!connection
		)
			return false;
		if (connection.generation !== args.generation) return false;
		await ctx.db.patch('hubspotQuotePushes', row._id, {
			state: 'dispatched',
			dispatchedAt: Date.now(),
			updatedAt: Date.now()
		});
		await clearCurrent(ctx, row);
		// A lost execution is observed, never retried as a second POST.
		await ctx.scheduler.runAfter(
			Math.max(0, quoteRunningUntil(row) - Date.now()),
			internal.hubspotQuotes.pump,
			{}
		);
		return true;
	}
});

/** Settlement remains valid after uninstall/source edits, without restoring any authorization. */
export const settle = internalMutation({
	args: {
		id: v.id('hubspotQuotePushes'),
		claim: v.string(),
		state: schema.doc('hubspotQuotePushes').fields.state,
		quoteId: v.optional(v.string()),
		url: v.optional(v.string()),
		message: v.optional(v.string()),
		providerFailure: v.optional(quoteProviderFailure),
		delay: v.optional(v.number())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotQuotePushes', args.id);
		if (!row || row.claim !== args.claim) return null;
		if (!['queued', 'dispatched', 'verifying', 'unknown'].includes(row.state)) return null;
		const attempts = row.readAttempts + (row.state === 'verifying' ? 1 : 0);
		const state =
			(row.quoteId && args.state === 'retired') || (args.state === 'verifying' && attempts >= 8)
				? 'attention'
				: args.state;
		const now = Date.now();
		const dueAt =
			state === 'verifying'
				? now + Math.min(300_000, Math.max(1000, args.delay ?? 5000))
				: undefined;
		const failure = args.providerFailure;
		const capturedAt = failure
			? Number.isFinite(failure.capturedAt)
				? Math.min(now, Math.max(0, failure.capturedAt))
				: now
			: now;
		await ctx.db.patch('hubspotQuotePushes', row._id, {
			state,
			updatedAt: Date.now(),
			dueAt,
			readAttempts: attempts,
			quoteId: args.quoteId ?? row.quoteId,
			url: args.url ?? row.url,
			message:
				state === 'attention' && !args.message
					? 'The quote exists, but Dinu could not verify the complete transfer. Open it in HubSpot and contact Dinu support.'
					: args.message,
			...(failure
				? {
						providerFailure: {
							capturedAt,
							expiresAt: capturedAt + retention,
							phase: failure.phase,
							purpose: failure.purpose,
							stage: failure.stage,
							status: Number.isFinite(failure.status)
								? Math.max(0, Math.min(599, Math.trunc(failure.status)))
								: 0,
							retryAfter: Number.isFinite(failure.retryAfter)
								? Math.max(0, Math.min(300_000, failure.retryAfter))
								: 60_000,
							...(hubspotErrorIdentifier(failure.category) ? { category: failure.category } : {}),
							...(hubspotErrorIdentifier(failure.code) ? { code: failure.code } : {}),
							...(hubspotErrorIdentifier(failure.correlationId)
								? { correlationId: failure.correlationId }
								: {})
						}
					}
				: {}),
			claim: state === 'unknown' ? row.claim : undefined,
			leaseUntil: undefined,
			workId: undefined
		});
		if (state !== 'queued') await clearCurrent(ctx, row);
		if (dueAt !== undefined)
			await ctx.scheduler.runAfter(
				Math.max(0, dueAt - Date.now()),
				internal.hubspotQuotes.pump,
				{}
			);
		return null;
	}
});

export const check = mutation({
	args: { membershipId: v.id('memberships'), id: v.id('hubspotQuotePushes') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const row = await ctx.db.get('hubspotQuotePushes', args.id);
		if (
			!row ||
			row.companyId !== access.companyId ||
			!accessibleContract(await ctx.db.get('savedContracts', row.contractId), access)
		)
			throw new ConvexError('This quote is unavailable.');
		if (row.state !== 'attention' || !row.quoteId) return null;
		if (!row.fileId || (row.payloadExpiresAt ?? 0) <= Date.now())
			throw new ConvexError(
				'The verification bytes expired. Review the existing quote in HubSpot; Dinu cannot recheck this transfer.'
			);
		await ctx.db.patch('hubspotQuotePushes', row._id, {
			state: 'verifying',
			claim: undefined,
			workId: undefined,
			readAttempts: 0,
			dueAt: Date.now(),
			leaseUntil: undefined
		});
		await ctx.scheduler.runAfter(0, internal.hubspotQuotes.pump, {});
		return null;
	}
});

/** A fixed-cutoff indexed pass drains promptly and skips running rows without starvation. */
export const expire = internalMutation({
	args: {
		kind: v.optional(v.union(v.literal('payload'), v.literal('diagnostic'))),
		cutoff: v.optional(v.number()),
		cursor: v.optional(v.string()),
		blockedUntil: v.optional(v.number())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const kind = args.kind ?? 'payload';
		const cutoff = args.cutoff ?? Date.now();
		let blockedUntil = args.blockedUntil;
		if (!args.kind)
			await ctx.scheduler.runAfter(0, internal.hubspotQuotes.expire, {
				kind: 'diagnostic',
				cutoff
			});
		const due = ctx.db.query('hubspotQuotePushes');
		const page = await (
			kind === 'payload'
				? due.withIndex('by_payloadExpiresAt', (q) =>
						q.gt('payloadExpiresAt', 0).lte('payloadExpiresAt', cutoff)
					)
				: due.withIndex('by_providerFailure_expiresAt', (q) =>
						q.gt('providerFailure.expiresAt', 0).lte('providerFailure.expiresAt', cutoff)
					)
		).paginate({ cursor: args.cursor ?? null, numItems: 25 });
		for (const row of page.page) {
			if (kind === 'diagnostic') {
				await ctx.db.patch('hubspotQuotePushes', row._id, {
					providerFailure: undefined
				});
				continue;
			}
			const runningUntil = quoteRunningUntil(row);
			if (runningUntil > Date.now()) {
				blockedUntil = Math.min(blockedUntil ?? Infinity, runningUntil);
				continue;
			}
			if (row.workId) await pool.cancel(ctx, row.workId as import('@convex-dev/workpool').WorkId);
			const active = ['queued', 'dispatched', 'verifying'].includes(row.state);
			await ctx.db.patch('hubspotQuotePushes', row._id, {
				fileId: undefined,
				payloadExpiresAt: undefined,
				workId: undefined,
				leaseUntil: undefined,
				// An already dispatched worker may truthfully identify its result later.
				claim: row.state === 'dispatched' || row.state === 'unknown' ? row.claim : undefined,
				...(active
					? {
							state:
								row.state === 'dispatched'
									? ('unknown' as const)
									: row.quoteId
										? ('attention' as const)
										: ('retired' as const),
							dueAt: undefined,
							updatedAt: Date.now(),
							message:
								row.state === 'dispatched'
									? 'HubSpot may have created this quote. Contact Dinu support before pushing this version again.'
									: 'The transfer verification period ended. Existing HubSpot quotes are retained.'
						}
					: {})
			});
			await clearCurrent(ctx, row);
			if (row.fileId) await deleteUnownedFile(ctx, row.fileId);
		}
		if (!page.isDone)
			await ctx.scheduler.runAfter(0, internal.hubspotQuotes.expire, {
				kind,
				cutoff,
				cursor: page.continueCursor,
				...(blockedUntil !== undefined ? { blockedUntil } : {})
			});
		else if (blockedUntil !== undefined)
			await ctx.scheduler.runAfter(
				Math.max(1000, blockedUntil - Date.now()),
				internal.hubspotQuotes.expire,
				{ kind }
			);
		return null;
	}
});

/** A bounded preparation turn can outlive an action without consuming a provider attempt. */
export const deferPreparation = internalMutation({
	args: { id: v.id('hubspotQuotePushes'), claim: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotQuotePushes', args.id);
		if (row?.state === 'queued' && row.claim === args.claim && row.dispatchedAt === undefined) {
			await ctx.db.patch('hubspotQuotePushes', row._id, {
				claim: undefined,
				workId: undefined,
				leaseUntil: undefined,
				dueAt: Date.now() + 1000
			});
			await ctx.scheduler.runAfter(1000, internal.hubspotQuotes.pump, {});
		}
		return null;
	}
});
