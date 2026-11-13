/** Private erasure ends provider recovery. Only an exact terminal-sender, reviewed dispatch disposition can release. */
import { ConvexError, v } from 'convex/values';
import { paginationResultValidator } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import { availableCompany } from './auth';
import { attemptIdFromReference, newDispatchId, validProviderScope } from './csmIdentity';
import { guardTerminal } from './csmErasureGuardValidators';
import { isSenderExecutionTerminal } from './csmBookingValidators';
import { safeFailedEvidence } from './csmAttemptState';
import schema from './schema';

type Guard = Doc<'csmErasedInitialGuards'>;
export async function blockingInitialGuard(ctx: QueryCtx, companyId: Id<'company'>) {
	return ctx.db
		.query('csmErasedInitialGuards')
		.withIndex('by_companyId_and_blocking', (q) =>
			q.eq('companyId', companyId).eq('blocking', true)
		)
		.first();
}
/** The obligation was deduplicated at ingress; retain no private reference. */
export async function noteErasedInitialEvidence(ctx: MutationCtx, reference: string) {
	if (!attemptIdFromReference(reference)) return;
	const parts = reference.split('.');
	if (parts.length !== 4 || parts[1] !== 'v2') return;
	const guard = await ctx.db
		.query('csmErasedInitialGuards')
		.withIndex('by_dispatchId', (q) => q.eq('dispatchId', parts[2]))
		.unique();
	if (!guard || !(await availableCompany(ctx, guard.companyId))) return;
	await ctx.db.patch('csmErasedInitialGuards', guard._id, {
		generation: guard.generation + 1,
		review: undefined,
		blocking: true,
		disposition:
			guard.disposition === 'externalBookingExists' ? 'externalBookingExists' : 'unresolved',
		reviewReason: 'lateErasedDispatchEvidence'
	});
}
async function observe(ctx: MutationCtx, g: Guard) {
	if (
		!g.sendJobId ||
		(g.terminal?.sendJobId === g.sendJobId && isSenderExecutionTerminal(g.terminal.kind))
	)
		return g;
	const job = await ctx.db.system.get('_scheduled_functions', g.sendJobId);
	if (job && isSenderExecutionTerminal(job.state.kind)) {
		const terminal = { sendJobId: g.sendJobId, kind: job.state.kind, observedAt: Date.now() };
		const fields = {
			terminal,
			generation: g.generation + 1,
			observeAt: undefined,
			review: undefined
		};
		await ctx.db.patch('csmErasedInitialGuards', g._id, fields);
		return { ...g, ...fields };
	}
	const rounds = g.observationRounds + 1;
	const fields = {
		...(g.terminal ? { terminal: undefined, review: undefined, generation: g.generation + 1 } : {}),
		observationRounds: rounds,
		observeAt: job && rounds < 24 ? Date.now() + 30_000 : undefined,
		reviewReason: job ? 'senderNotTerminal' : 'senderUnobservable'
	};
	await ctx.db.patch('csmErasedInitialGuards', g._id, fields);
	return { ...g, ...fields };
}
export async function preserveErasedInitial(ctx: MutationCtx, a: Doc<'csmBookingAttempts'>) {
	if (
		a.mode !== 'setup' ||
		a.replacement ||
		a.state === 'queued' ||
		(a.state === 'booked' && a.confirmation) ||
		safeFailedEvidence(a)
	)
		return;
	if (!(await availableCompany(ctx, a.companyId))) return;
	const identity = newDispatchId();
	const terminal = isSenderExecutionTerminal(a.senderTerminal?.kind) ? a.senderTerminal : undefined;
	const id = await ctx.db.insert('csmErasedInitialGuards', {
		companyId: a.companyId,
		identity,
		...(a.dispatchId ? { dispatchId: a.dispatchId } : {}),
		...(a.providerScope ? { scope: a.providerScope } : {}),
		generation: 0,
		phase:
			a.state === 'submitting'
				? 'submitting'
				: a.state === 'unknown'
					? 'unknown'
					: 'legacyUncertain',
		...(a.sendJobId ? { sendJobId: a.sendJobId } : {}),
		...(a.sendJobId && terminal ? { terminal: { sendJobId: a.sendJobId, ...terminal } } : {}),
		disposition: 'unresolved',
		blocking: true,
		reviewReason:
			a.dispatchId && a.sendJobId ? 'erasedUncertainty' : 'missingOriginalDispatchFence',
		observeAt: a.sendJobId && !terminal ? Date.now() : undefined,
		observationRounds: 0
	});
	await observe(ctx, (await ctx.db.get('csmErasedInitialGuards', id))!);
}
export const inspect = internalQuery({
	args: {
		companyId: v.id('company'),
		blocking: v.optional(v.boolean()),
		cursor: v.union(v.string(), v.null())
	},
	returns: paginationResultValidator(schema.doc('csmErasedInitialGuards')),
	handler: (ctx, { companyId, blocking, cursor }) =>
		ctx.db
			.query('csmErasedInitialGuards')
			.withIndex('by_companyId_and_blocking', (q) =>
				blocking === undefined
					? q.eq('companyId', companyId)
					: q.eq('companyId', companyId).eq('blocking', blocking)
			)
			.paginate({ cursor, numItems: 25, maximumRowsRead: 25 })
});
export const beginReview = internalMutation({
	args: {
		id: v.id('csmErasedInitialGuards'),
		identity: v.string(),
		expectedGeneration: v.number()
	},
	returns: schema.doc('csmErasedInitialGuards'),
	handler: async (ctx, args) => {
		const g = await ctx.db.get('csmErasedInitialGuards', args.id);
		if (
			!g ||
			g.identity !== args.identity ||
			g.generation !== args.expectedGeneration ||
			!g.blocking ||
			!(await availableCompany(ctx, g.companyId))
		)
			throw new ConvexError('Inspect the current erased dispatch guard.');
		const observed = await observe(ctx, g);
		if (
			!observed.dispatchId ||
			!validProviderScope(observed.scope) ||
			!observed.sendJobId ||
			!observed.terminal ||
			!isSenderExecutionTerminal(observed.terminal.kind) ||
			observed.terminal.sendJobId !== observed.sendJobId
		)
			throw new ConvexError('The exact original dispatch and terminal sender must be observable.');
		const generation = observed.generation + 1;
		await ctx.db.patch('csmErasedInitialGuards', g._id, {
			generation,
			review: { generation, terminal: observed.terminal, begunAt: Date.now() }
		});
		return (await ctx.db.get('csmErasedInitialGuards', g._id))!;
	}
});
export const resolve = internalMutation({
	args: {
		id: v.id('csmErasedInitialGuards'),
		identity: v.string(),
		expectedGeneration: v.number(),
		terminal: guardTerminal,
		disposition: v.union(v.literal('notCreated'), v.literal('externalBookingExists')),
		investigatedAt: v.number(),
		exactDispatchAssociation: v.literal(true),
		exhaustiveOriginalDispatchInvestigation: v.literal(true),
		operator: v.string(),
		evidence: v.string(),
		reason: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const g = await ctx.db.get('csmErasedInitialGuards', args.id),
			now = Date.now();
		const validText = [args.operator, args.evidence, args.reason].every(
			(x) => !!x.trim() && x.length <= 2000
		);
		if (
			!g ||
			g.identity !== args.identity ||
			g.generation !== args.expectedGeneration ||
			g.review?.generation !== args.expectedGeneration ||
			!g.blocking ||
			!g.dispatchId ||
			!validProviderScope(g.scope) ||
			!g.sendJobId ||
			!g.terminal ||
			!isSenderExecutionTerminal(g.terminal.kind) ||
			!validText ||
			!(await availableCompany(ctx, g.companyId)) ||
			JSON.stringify(g.terminal) !== JSON.stringify(args.terminal) ||
			JSON.stringify(g.review.terminal) !== JSON.stringify(args.terminal) ||
			g.terminal.sendJobId !== g.sendJobId ||
			!Number.isFinite(args.investigatedAt) ||
			args.investigatedAt < g.review.begunAt ||
			args.investigatedAt < g.terminal.observedAt ||
			args.investigatedAt > now ||
			now - g.review.begunAt > 15 * 60_000
		)
			throw new ConvexError(
				'Fresh terminal-before-investigation evidence for this unchanged dispatch guard is required.'
			);
		await ctx.db.patch('csmErasedInitialGuards', g._id, {
			disposition: args.disposition,
			blocking: args.disposition !== 'notCreated',
			generation: g.generation + 1,
			review: undefined,
			observeAt: undefined,
			reviewReason: args.disposition,
			resolution: {
				operator: args.operator,
				evidence: args.evidence,
				reason: args.reason,
				at: now,
				investigatedAt: args.investigatedAt
			}
		});
		// A positive disposition deliberately creates no appointment, profile, receipt or qualification.
		return null;
	}
});
export const pump = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const rows = await ctx.db
			.query('csmErasedInitialGuards')
			.withIndex('by_observeAt', (q) => q.gt('observeAt', 0).lte('observeAt', Date.now()))
			.take(25);
		for (const g of rows) {
			if (!(await availableCompany(ctx, g.companyId))) continue;
			await observe(ctx, g);
		}
		return null;
	}
});
