import { ConvexError, v } from 'convex/values';
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
import { installation, requireContractWork } from './contractPolicy';
import { approvedExport } from './documentExport';
import { quoteInstallationFor } from './hubspotQuotesInstallation';
import { hubspotDestination } from './hubspotValidators';
import {
	hasQuoteScopes,
	quoteSummary,
	quoteProviderFailure,
	quoteRunningUntil
} from './hubspotQuoteValidators';
import { exportRequest } from './savedContractValidators';
import { sourceBlock } from '../lib/document/source-validators';
import { contractItem } from './contractItemValidators';
import { pool } from './hubspotDelivery';
import { receipt, remember, actionKey } from './hubspotRecords';
import { deleteUnownedFile } from './storageOwnership';
import schema from './schema';
import { hubspotErrorIdentifier } from './hubspotApi';

type Push = Doc<'hubspotQuotePushes'>;
const summary = (row: Push) => ({
	id: row._id,
	state: row.state,
	canonicalKey: row.canonicalKey,
	url: row.url ?? null,
	message: row.message ?? null
});
const retention = 30 * 24 * 60 * 60_000;

async function requireQuotes(ctx: QueryCtx, contract: Doc<'savedContracts'>) {
	const connection = await requireContractWork(ctx, contract);
	const quotes = await quoteInstallationFor(ctx, contract.companyId);
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
	// requireContractWork proved the connected installation has an available matching link.
	return { connection, quotes, destination: contract.hubspot! };
}

/** Background authorization uses the captured actor's current membership, never browser auth. */
async function authorized(ctx: QueryCtx, row: Push, checkApprovals = false) {
	if (
		!(await availableCompany(ctx, row.companyId)) ||
		!(await liveCompanyMember(ctx, row.companyId, row.profileId))
	)
		return null;
	const member = await ctx.db.get('memberships', row.membershipId);
	const contract = await ctx.db.get('savedContracts', row.contractId);
	if (
		!member ||
		member.profileId !== row.profileId ||
		member.companyId !== row.companyId ||
		!contract ||
		contract.companyId !== row.companyId ||
		contract.editRevision !== row.editRevision ||
		contract.reviewGeneration !== row.reviewGeneration ||
		contract.templateVersionId !== row.templateVersionId ||
		contract.buyerCompanyName !== row.title
	)
		return null;
	try {
		const { connection, quotes, destination } = await requireQuotes(ctx, contract);
		if (
			quotes._id !== row.installationId ||
			quotes.epoch !== row.epoch ||
			connection._id !== row.destination.connectionId ||
			destination.accountId !== row.destination.accountId ||
			destination.dealId !== row.destination.dealId ||
			destination.generation !== row.destination.generation
		)
			return null;
		if (checkApprovals) await approvedExport(ctx, contract);
		return connection;
	} catch {
		return null;
	}
}

export const content = internalQuery({
	args: exportRequest.fields,
	returns: v.object({
		contract: schema.doc('savedContracts'),
		blocks: v.array(sourceBlock),
		items: v.array(contractItem)
	}),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const contract = accessibleContract(await ctx.db.get('savedContracts', args.id), access);
		if (!contract) throw new ConvexError('This contract was deleted.');
		await requireQuotes(ctx, contract);
		if (contract.editRevision !== args.expectedEditRevision)
			throw new ConvexError('This contract changed. Wait for it to finish saving.');
		const { reader, items } = await approvedExport(ctx, contract);
		return { contract, blocks: await reader.blocks(), items };
	}
});

export const reserve = internalMutation({
	args: exportRequest.extend({
		operationId: v.string(),
		fileId: v.optional(v.id('_storage')),
		fingerprint: v.string(),
		payloadHash: v.string(),
		canonicalKey: v.string(),
		reviewGeneration: v.number(),
		destination: hubspotDestination,
		title: v.string(),
		templateVersionId: v.id('templateVersions')
	}).fields,
	returns: v.union(
		v.object({ kind: v.literal('reused'), summary: quoteSummary }),
		v.object({ kind: v.literal('payload-required') })
	),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		if (!/^[\w-]{1,100}$/u.test(args.operationId)) throw new ConvexError('Invalid push operation.');
		const contract = accessibleContract(await ctx.db.get('savedContracts', args.id), access);
		if (!contract) throw new ConvexError('This contract was deleted.');
		const { connection, quotes, destination } = await requireQuotes(ctx, contract);
		if (
			contract.editRevision !== args.expectedEditRevision ||
			contract.reviewGeneration !== args.reviewGeneration ||
			contract.templateVersionId !== args.templateVersionId ||
			contract.buyerCompanyName !== args.title ||
			destination.connectionId !== args.destination.connectionId ||
			destination.accountId !== args.destination.accountId ||
			destination.dealId !== args.destination.dealId ||
			destination.generation !== args.destination.generation
		)
			throw new ConvexError('This contract changed. Wait for it to finish saving.');
		await approvedExport(ctx, contract);
		const operationKey = actionKey(access, 'quote', args.operationId);
		const inputs = JSON.stringify([contract._id, contract.editRevision, args.canonicalKey]);
		const operation = await receipt(ctx, operationKey, inputs);
		const prior = await ctx.db
			.query('hubspotQuotePushes')
			.withIndex('by_canonicalKey', (q) => q.eq('canonicalKey', args.canonicalKey))
			.unique();
		const now = Date.now();
		const lastRequest = await ctx.db
			.query('hubspotQuotePushes')
			.withIndex('by_contractId_and_requestedAt', (q) => q.eq('contractId', contract._id))
			.order('desc')
			.first();
		// Serialize explicit uses even when two requests arrive in the same millisecond.
		const requestedAt = Math.max(
			now,
			(lastRequest?.requestedAt ?? lastRequest?._creationTime ?? 0) + 1
		);
		const reusable =
			prior &&
			!['rejected', 'retired'].includes(prior.state) &&
			(prior.state !== 'queued' || (await authorized(ctx, prior, true)));
		if (reusable) {
			if (!operation) await remember(ctx, access.companyId, operationKey, inputs, prior._id);
			await ctx.db.patch('hubspotQuotePushes', prior._id, { requestedAt });
			return { kind: 'reused' as const, summary: summary(prior) };
		}
		// Admission and the allocating commit share this transaction/decision path.
		if (prior && quoteRunningUntil(prior) > now)
			throw new ConvexError('This push is still stopping. Wait a moment, then push again.');
		if (!args.fileId) return { kind: 'payload-required' as const };
		if (prior?.workId)
			await pool.cancel(ctx, prior.workId as import('@convex-dev/workpool').WorkId);
		const value = {
			companyId: access.companyId,
			contractId: contract._id,
			membershipId: access.membershipId,
			profileId: access.profile._id,
			installationId: quotes._id,
			epoch: quotes.epoch,
			destination: {
				connectionId: connection._id,
				accountId: destination.accountId,
				dealId: destination.dealId,
				generation: destination.generation
			},
			canonicalKey: args.canonicalKey,
			fingerprint: args.fingerprint,
			payloadHash: args.payloadHash,
			templateVersionId: contract.templateVersionId,
			editRevision: contract.editRevision,
			reviewGeneration: contract.reviewGeneration,
			title: contract.buyerCompanyName,
			...(prior?.previousQuoteId ? { previousQuoteId: prior.previousQuoteId } : {}),
			...(prior?.recoveryEvidence ? { recoveryEvidence: prior.recoveryEvidence } : {}),
			...(prior?.providerFailure ? { providerFailure: prior.providerFailure } : {}),
			...(prior?.correlationId ? { correlationId: prior.correlationId } : {}),
			state: 'queued' as const,
			requestedAt,
			updatedAt: now,
			fileId: args.fileId,
			payloadExpiresAt: now + retention,
			readAttempts: 0,
			dueAt: now
		};
		const id = prior?._id ?? (await ctx.db.insert('hubspotQuotePushes', value));
		if (prior) {
			await ctx.db.replace('hubspotQuotePushes', id, value);
			if (prior.fileId && prior.fileId !== args.fileId) await deleteUnownedFile(ctx, prior.fileId);
		}
		if (!operation) await remember(ctx, access.companyId, operationKey, inputs, id);
		await ctx.scheduler.runAfter(0, internal.hubspotQuotes.pump, {});
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
			const requested = await ctx.db
				.query('hubspotQuotePushes')
				.withIndex('by_contractId_and_requestedAt', (q) => q.eq('contractId', args.id))
				.order('desc')
				.first();
			// Bounded compatibility while the additive timestamp backfill completes.
			const legacy = await ctx.db
				.query('hubspotQuotePushes')
				.withIndex('by_contractId_and_requestedAt', (q) =>
					q.eq('contractId', args.id).eq('requestedAt', undefined)
				)
				.order('desc')
				.first();
			row =
				legacy &&
				(!requested || legacy._creationTime > (requested.requestedAt ?? requested._creationTime))
					? legacy
					: requested;
		}
		return row?.companyId === access.companyId && row.contractId === args.id ? summary(row) : null;
	}
});

/** Retire only work proven unsent, or stop readback while preserving its known quote. */
async function stop(ctx: MutationCtx, row: Push, message: string) {
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
			connection: schema.doc('hubspotConnections')
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
		const connection =
			row.state === 'queued'
				? await authorized(ctx, row, true)
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
		return { push: { ...row, leaseUntil }, connection };
	}
});

export const dispatch = internalMutation({
	args: { id: v.id('hubspotQuotePushes'), claim: v.string(), generation: v.number() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotQuotePushes', args.id);
		const connection = row ? await authorized(ctx, row, true) : null;
		if (
			!row ||
			row.state !== 'queued' ||
			row.claim !== args.claim ||
			(row.leaseUntil ?? 0) <= Date.now() ||
			!connection
		)
			return false;
		if (connection.generation !== args.generation) return false;
		await ctx.db.patch('hubspotQuotePushes', row._id, {
			state: 'dispatched',
			updatedAt: Date.now()
		});
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
					providerFailure: undefined,
					correlationId: undefined
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

/** Compatibility only: native creation time is the conservative historical latest-use fallback. */
export const backfillRequestedAt = internalMutation({
	args: { cursor: v.optional(v.string()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query('hubspotQuotePushes')
			.withIndex('by_contractId')
			.paginate({ cursor: args.cursor ?? null, numItems: 25 });
		for (const row of page.page)
			if (row.requestedAt === undefined)
				await ctx.db.patch('hubspotQuotePushes', row._id, { requestedAt: row._creationTime });
		if (!page.isDone)
			await ctx.scheduler.runAfter(0, internal.hubspotQuotes.backfillRequestedAt, {
				cursor: page.continueCursor
			});
		return null;
	}
});
