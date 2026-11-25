import { ConvexError, v, type Infer } from 'convex/values';
import type { WorkId } from '@convex-dev/workpool';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
	env,
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import { approvedConcessionMap, contractReadiness } from '../lib/contract/changes';
import { sourceBlock } from '../lib/document/source-validators';
import { accessibleContract, availableCompany, liveCompanyMember, requireMembership } from './auth';
import { appliedOverlay } from './buyerValidators';
import { installation, requireContractWork } from './contractPolicy';
import { accessibleContractState, readContract, type Contract } from './contractState';
import { hubspotErrorIdentifier } from './hubspotApi';
import { pool } from './hubspotDelivery';
import { quoteInstallationFor } from './hubspotQuotesInstallation';
import {
	hasQuoteScopes,
	quoteProviderFailure,
	quoteRequest,
	quoteRunningUntil,
	quoteState,
	quoteSummary
} from './hubspotQuoteValidators';
import { actionKey, actorOf, receipt, remember, validateOperationId } from './operationReceipts';
import schema from './schema';
import { deleteUnownedFile } from './storageOwnership';
import { readAppliedOverlays, snapshotReader } from './templates';

type Push = Doc<'hubspotQuotePushes'>;
type Request = Infer<typeof quoteRequest>;

const RETENTION_MS = 30 * 24 * 60 * 60_000;

const summary = (row: Push) => ({
	id: row._id,
	state: row.state,
	canonicalKey: row.canonicalKey,
	url: row.url ?? null,
	message: row.message ?? null
});

const conclusiveQuote = (row: Pick<Push, 'state'>) =>
	['verified', 'rejected', 'retired'].includes(row.state);

const sameDestination = (a: Request['destination'], b: Request['destination']) =>
	a.connectionId === b.connectionId &&
	a.accountId === b.accountId &&
	a.dealId === b.dealId &&
	a.generation === b.generation;

const requestInputs = (args: Request) =>
	JSON.stringify([args.id, 'hubspot-quote', args.expectedStateRevision, args.destination]);

async function requireQuotes(ctx: QueryCtx, contract: Contract) {
	const connection = await requireContractWork(ctx, contract);
	const quotes = await quoteInstallationFor(ctx, contract.root.companyId);
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
	const { availability: _availability, ...destination } = contract.hubspot!;
	return { connection, quotes, destination };
}

/** Live gate checked at pump/start/dispatch so changed contracts or revoked access never dispatch. */
async function gated(ctx: QueryCtx, row: Push) {
	if (
		!(await availableCompany(ctx, row.companyId)) ||
		!(await liveCompanyMember(ctx, row.companyId, row.profileId))
	)
		return null;
	const [member, root, cleanup] = await Promise.all([
		ctx.db.get('memberships', row.membershipId),
		ctx.db.get('savedContracts', row.contractId),
		ctx.db
			.query('contractCleanups')
			.withIndex('by_contractId', (q) => q.eq('contractId', row.contractId))
			.unique()
	]);
	if (
		!member ||
		member.profileId !== row.profileId ||
		member.companyId !== row.companyId ||
		!root ||
		root.companyId !== row.companyId ||
		root.templateVersionId !== row.templateVersionId ||
		root.stateRevision !== row.stateRevision ||
		root.title !== row.title ||
		!contractReadiness(root.concessions).ready ||
		cleanup
	)
		return null;
	try {
		const contract = await readContract(ctx, root);
		const access = await requireQuotes(ctx, contract);
		if (
			access.quotes._id !== row.installationId ||
			access.quotes.epoch !== row.installationEpoch ||
			!sameDestination(access.destination, row.destination)
		)
			return null;
		return { ...access, contract };
	} catch {
		return null;
	}
}

async function resolveCommittedReceipt(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	contractId: Id<'savedContracts'>,
	result: string
) {
	const id = ctx.db.normalizeId('hubspotQuotePushes', result);
	const push = id ? await ctx.db.get('hubspotQuotePushes', id) : null;
	if (!push || push.companyId !== companyId || push.contractId !== contractId)
		throw new ConvexError('This push result is unavailable.');
	return summary(push);
}

const prepareResult = v.union(
	v.object({ kind: v.literal('committed'), summary: quoteSummary }),
	v.object({
		kind: v.literal('generate'),
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		templateVersionId: v.id('templateVersions'),
		title: v.string(),
		stateRevision: v.number(),
		blocks: v.array(sourceBlock),
		appliedOverlays: v.array(appliedOverlay),
		concessions: v.record(v.id('playbookItems'), v.string()),
		destination: quoteRequest.fields.destination
	})
);

export const prepare = internalQuery({
	args: quoteRequest.fields,
	returns: prepareResult,
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		validateOperationId(args.operationId);
		const key = actionKey(access, 'quote', args.operationId);
		const inputs = requestInputs(args);
		const prior = await receipt(ctx, key, inputs);
		if (prior) {
			if (prior.companyId !== access.companyId || prior.contractId !== args.id)
				throw new ConvexError('This push operation was already used.');
			return {
				kind: 'committed' as const,
				summary: await resolveCommittedReceipt(ctx, access.companyId, args.id, prior.result)
			};
		}

		const contract = await accessibleContractState(ctx, args.id, access);
		if (!contract) throw new ConvexError('This contract is unavailable.');
		if (contract.root.stateRevision !== args.expectedStateRevision)
			throw new ConvexError(
				'The saved contract changed. Review the current contract and try again.'
			);
		if (!contractReadiness(contract.root.concessions).ready)
			throw new ConvexError('Approve or remove pending concessions before pushing a quote.');
		const { destination } = await requireQuotes(ctx, contract);
		if (!sameDestination(args.destination, destination))
			throw new ConvexError('The linked HubSpot deal changed. Prepare a new push.');

		const concessions = approvedConcessionMap(contract.root.concessions);
		const reader = await snapshotReader(ctx, contract.root);
		const [blocks, appliedOverlays] = await Promise.all([
			reader.blocks(),
			readAppliedOverlays(reader, concessions)
		]);
		return {
			kind: 'generate' as const,
			companyId: access.companyId,
			contractId: contract.root._id,
			templateVersionId: contract.root.templateVersionId,
			title: contract.root.title,
			stateRevision: contract.root.stateRevision,
			blocks,
			appliedOverlays,
			concessions,
			destination
		};
	}
});

/** Commit immutable bytes and provider identity; deduplicated pushes reuse their existing row. */
export const commit = internalMutation({
	args: {
		...quoteRequest.fields,
		fileId: v.optional(v.id('_storage')),
		fingerprint: v.string(),
		payloadHash: v.string(),
		canonicalKey: v.string(),
		preparedTemplateVersionId: v.id('templateVersions'),
		expectedTitle: v.string()
	},
	returns: v.union(
		v.object({ kind: v.literal('reused'), summary: quoteSummary }),
		v.object({ kind: v.literal('payload-required') })
	),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		validateOperationId(args.operationId);
		if (
			![args.fingerprint, args.payloadHash, args.canonicalKey].every((value) =>
				/^[a-f0-9]{64}$/u.test(value)
			)
		)
			throw new ConvexError('Invalid immutable push payload.');

		const key = actionKey(access, 'quote', args.operationId);
		const inputs = requestInputs(args);
		const priorReceipt = await receipt(ctx, key, inputs);
		if (priorReceipt) {
			if (priorReceipt.companyId !== access.companyId || priorReceipt.contractId !== args.id)
				throw new ConvexError('This push operation was already used.');
			return {
				kind: 'reused' as const,
				summary: await resolveCommittedReceipt(ctx, access.companyId, args.id, priorReceipt.result)
			};
		}

		const contract = await accessibleContractState(ctx, args.id, access);
		if (!contract) throw new ConvexError('This contract is unavailable.');
		if (
			contract.root.templateVersionId !== args.preparedTemplateVersionId ||
			contract.root.stateRevision !== args.expectedStateRevision ||
			contract.root.title !== args.expectedTitle
		)
			throw new ConvexError(
				'The saved contract changed. Review the current contract and try again.'
			);
		if (!contractReadiness(contract.root.concessions).ready)
			throw new ConvexError('Approve or remove pending concessions before pushing a quote.');
		const { quotes, destination } = await requireQuotes(ctx, contract);
		if (!sameDestination(args.destination, destination))
			throw new ConvexError('The linked HubSpot deal changed. Prepare a new push.');

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
				candidate.destination.accountId !== destination.accountId ||
				candidate.destination.dealId !== destination.dealId
			)
				throw new Error('Invalid quote deduplication identity.');
			if (candidate.state !== 'queued') {
				prior = candidate;
				break;
			}
			if (await gated(ctx, candidate)) {
				prior = candidate;
				break;
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

		const now = Date.now();
		const id =
			prior?._id ??
			(await ctx.db.insert('hubspotQuotePushes', {
				companyId: access.companyId,
				contractId: contract.root._id,
				templateVersionId: contract.root.templateVersionId,
				stateRevision: contract.root.stateRevision,
				title: contract.root.title,
				membershipId: access.membershipId,
				profileId: access.profile._id,
				actor: actorOf(access.profile),
				installationId: quotes._id,
				installationEpoch: quotes.epoch,
				destination,
				canonicalKey: args.canonicalKey,
				fingerprint: args.fingerprint,
				payloadHash: args.payloadHash,
				state: 'queued',
				updatedAt: now,
				fileId: args.fileId!,
				payloadExpiresAt: now + RETENTION_MS,
				readAttempts: 0,
				dueAt: now
			}));

		await remember(ctx, access.companyId, key, inputs, id, args.id);
		const requestedAt = Math.max(now, (contract.root.quoteRequests?.watermark ?? 0) + 1);
		await ctx.db.patch('savedContracts', contract.root._id, {
			quoteRequests: {
				watermark: requestedAt,
				latest: { requestedAt, pushId: id }
			}
		});
		if (!prior) await ctx.scheduler.runAfter(0, internal.hubspotQuotes.pump, {});
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
		const root = await ctx.db.get('savedContracts', args.id);
		if (!root || !accessibleContract(root, access)) return null;
		const pushId = args.pushId ?? root.quoteRequests?.latest?.pushId;
		const row = pushId ? await ctx.db.get('hubspotQuotePushes', pushId) : null;
		return row?.companyId === access.companyId && row.contractId === args.id ? summary(row) : null;
	}
});

async function stop(ctx: MutationCtx, row: Push, message: string) {
	if (row.workId) await pool.cancel(ctx, row.workId as WorkId);
	const now = Date.now();
	const state = row.quoteId ? ('attention' as const) : ('retired' as const);
	await ctx.db.patch('hubspotQuotePushes', row._id, {
		state,
		message,
		claim: undefined,
		workId: undefined,
		leaseUntil: undefined,
		dueAt: undefined,
		updatedAt: now,
		...(state === 'retired' ? { settledAt: now } : {})
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
				if (
					!row.fileId ||
					(row.payloadExpiresAt ?? 0) <= now ||
					(state === 'queued' && !(await gated(ctx, row)))
				) {
					await stop(
						ctx,
						row,
						'This push stopped before sending. Check the saved contract and integration, then push again.'
					);
					continue;
				}
				if (row.workId && !row.leaseUntil) {
					const status = await pool.status(ctx, row.workId as WorkId);
					if (status.state !== 'finished') {
						await ctx.db.patch('hubspotQuotePushes', row._id, { dueAt: now + 60_000 });
						continue;
					}
				}
				if (row.workId) await pool.cancel(ctx, row.workId as WorkId);
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
		const connection =
			row.state === 'queued'
				? ((await gated(ctx, row))?.connection ?? null)
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
		return { push: { ...row, leaseUntil }, connection, title: row.title };
	}
});

export const dispatch = internalMutation({
	args: { id: v.id('hubspotQuotePushes'), claim: v.string(), generation: v.number() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotQuotePushes', args.id);
		const gate = row ? await gated(ctx, row) : null;
		if (
			!row ||
			row.state !== 'queued' ||
			row.dispatchedAt !== undefined ||
			row.claim !== args.claim ||
			(row.leaseUntil ?? 0) <= Date.now() ||
			!gate ||
			gate.connection.generation !== args.generation
		)
			return false;
		const now = Date.now();
		await ctx.db.patch('hubspotQuotePushes', row._id, {
			state: 'dispatched',
			dispatchedAt: now,
			updatedAt: now
		});
		// A lost execution is observed, never retried as a second POST.
		await ctx.scheduler.runAfter(
			Math.max(0, quoteRunningUntil(row) - now),
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
		state: quoteState,
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
			updatedAt: now,
			...(conclusiveQuote({ state }) ? { settledAt: now } : {}),
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
							expiresAt: capturedAt + RETENTION_MS,
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
				if (!conclusiveQuote(row) || row.workId || row.claim || row.leaseUntil !== undefined)
					continue;
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
			if (row.workId) await pool.cancel(ctx, row.workId as WorkId);
			const active = ['queued', 'dispatched', 'verifying'].includes(row.state);
			const fileToDelete = row.fileId;
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
			if (fileToDelete) await deleteUnownedFile(ctx, fileToDelete);
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
