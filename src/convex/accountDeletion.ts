import { v, ConvexError } from 'convex/values';
import { internalMutation, internalQuery, query, mutation } from './_generated/server';
import { internal } from './_generated/api';
import { requireProfile, creatorDeleted, companyDeletion } from './auth';
import { confirmAccountDeletion, PREPARATION_TTL } from './companyDeletion';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';

async function scheduleCleanup(ctx: MutationCtx, marker: Doc<'deletedUsers'>) {
	const generation = (marker.cleanupGeneration ?? 0) + 1;
	const jobId = await ctx.scheduler.runAfter(0, internal.accountDeletion.clean, {
		markerId: marker._id,
		generation
	});
	await ctx.db.patch('deletedUsers', marker._id, {
		cleanupJobId: jobId,
		cleanupGeneration: generation
	});
}

async function ensureCleanup(ctx: MutationCtx, marker: Doc<'deletedUsers'>) {
	if (marker.complete) return;
	const job = marker.cleanupJobId
		? await ctx.db.system.get('_scheduled_functions', marker.cleanupJobId)
		: null;
	if (job?.state.kind === 'pending' || job?.state.kind === 'inProgress') return;
	await scheduleCleanup(ctx, marker);
}

const deletionMode = v.union(
	v.literal('account'),
	v.literal('accountAndCompany'),
	v.literal('transferOwnership')
);
async function deletionOptions(ctx: QueryCtx) {
	const profile = await requireProfile(ctx);
	const membership = await ctx.db
		.query('memberships')
		.withIndex('by_profileId', (q) => q.eq('profileId', profile._id))
		.unique();
	const company = membership ? await ctx.db.get('company', membership.companyId) : null;
	const owned = await ctx.db
		.query('company')
		.withIndex('by_ownerProfileId', (q) => q.eq('ownerProfileId', profile._id))
		.first();
	let mode: 'account' | 'accountAndCompany' | 'transferOwnership' = 'account';
	if (owned && owned._id !== company?._id) mode = 'transferOwnership';
	else if (company) {
		// The range read conflicts with a concurrent join or leave. Invitations are not members.
		const members = ctx.db
			.query('memberships')
			.withIndex('by_companyId', (q) => q.eq('companyId', company._id));
		let hasColleague = false;
		let scanned = 0;
		for await (const member of members) {
			if (++scanned > 100)
				throw new ConvexError(
					'Company membership cleanup is still in progress. Try again shortly.'
				);
			if (member.profileId !== profile._id && !(await creatorDeleted(ctx, member.profileId))) {
				hasColleague = true;
				break;
			}
		}
		mode = hasColleague ? (owned ? 'transferOwnership' : 'account') : 'accountAndCompany';
	}
	const pending = company ? await companyDeletion(ctx, company._id) : null;
	return {
		profile,
		mode,
		companyId: company?._id ?? null,
		companyName: company?.name ?? null,
		marker: pending,
		pending: pending?.status === 'prepared' || pending?.status === 'dispatched'
	};
}
export const options = query({
	args: {},
	returns: v.object({
		mode: deletionMode,
		companyId: v.union(v.id('company'), v.null()),
		companyName: v.union(v.string(), v.null()),
		pending: v.boolean()
	}),
	handler: async (ctx) => {
		const { profile: _profile, marker: _marker, ...options } = await deletionOptions(ctx);
		return options;
	}
});
const preparationArgs = {
	mode: v.union(v.literal('account'), v.literal('accountAndCompany')),
	companyId: v.union(v.id('company'), v.null()),
	confirmation: v.string(),
	attemptId: v.string()
};
const requestState = v.union(v.literal('prepared'), v.literal('dispatched'));
const request = v.object({
	id: v.id('companyDeletions'),
	attemptId: v.string(),
	requestedAt: v.number(),
	status: requestState
});
function requestResult(marker: Doc<'companyDeletions'>, status: 'prepared' | 'dispatched') {
	return { id: marker._id, attemptId: marker.attemptId, requestedAt: marker.requestedAt, status };
}
async function validateDeletion(
	ctx: QueryCtx,
	args: {
		mode: 'account' | 'accountAndCompany';
		companyId: Doc<'company'>['_id'] | null;
		confirmation: string;
		attemptId: string;
	}
) {
	const options = await deletionOptions(ctx);
	if (options.mode === 'transferOwnership')
		throw new ConvexError('Transfer company ownership before deleting your account.');
	if (args.mode !== options.mode || args.companyId !== options.companyId)
		throw new ConvexError(
			'Your company membership changed. Review the deletion confirmation again.'
		);
	const phrase =
		options.mode === 'accountAndCompany' ? 'delete my account and company' : 'delete my account';
	if (args.confirmation.trim() !== phrase) throw new ConvexError(`Type "${phrase}" to continue.`);
	if (!args.attemptId || args.attemptId.length > 128)
		throw new ConvexError('Invalid deletion attempt.');
	return options;
}
export const prepare = mutation({
	// Older clients must fail before calling Clerk without durable dispatch.
	args: { ...preparationArgs, protocol: v.literal('dispatch') },
	returns: v.union(request, v.null()),
	handler: async (ctx, args) => {
		const options = await validateDeletion(ctx, args);
		if (options.mode === 'accountAndCompany' && options.companyId) {
			const existing = options.marker;
			if (
				existing &&
				((existing.status !== 'prepared' && existing.status !== 'dispatched') ||
					existing.issuer !== options.profile.issuer ||
					existing.clerkId !== options.profile.clerkId)
			)
				throw new ConvexError('Company deletion is already in progress.');
			if (existing?.status === 'dispatched') return requestResult(existing, 'dispatched');
			if (existing?.attemptId === args.attemptId) return requestResult(existing, 'prepared');
			const consent = {
				attemptId: args.attemptId,
				requestedAt: Date.now(),
				issuer: options.profile.issuer,
				clerkId: options.profile.clerkId
			};
			const id =
				existing?._id ??
				(await ctx.db.insert('companyDeletions', {
					...consent,
					companyId: options.companyId,
					status: 'prepared',
					phase: 'invitations'
				}));
			if (existing) await ctx.db.patch('companyDeletions', id, consent);
			await ctx.scheduler.runAfter(PREPARATION_TTL, internal.companyDeletion.expirePreparation, {
				id,
				attemptId: consent.attemptId,
				requestedAt: consent.requestedAt
			});
			return {
				id,
				attemptId: consent.attemptId,
				requestedAt: consent.requestedAt,
				status: 'prepared' as const
			};
		}
		return null;
	}
});
export const dispatch = mutation({
	args: { ...preparationArgs, requestId: v.union(v.id('companyDeletions'), v.null()) },
	returns: v.union(request, v.null()),
	handler: async (ctx, args) => {
		const options = await validateDeletion(ctx, args);
		if (options.mode === 'account') {
			if (args.requestId !== null)
				throw new ConvexError('Your deletion request changed. Try again.');
			return null;
		}
		const marker = options.marker;
		if (
			!marker ||
			marker._id !== args.requestId ||
			marker.attemptId !== args.attemptId ||
			marker.issuer !== options.profile.issuer ||
			marker.clerkId !== options.profile.clerkId
		)
			throw new ConvexError('Your deletion request changed. Review the confirmation again.');
		if (marker.status === 'dispatched') return requestResult(marker, 'dispatched');
		if (marker.status !== 'prepared' || marker.requestedAt + PREPARATION_TTL <= Date.now())
			throw new ConvexError('Your deletion preparation expired. Try again.');
		await ctx.db.patch('companyDeletions', marker._id, { status: 'dispatched' });
		return requestResult(marker, 'dispatched');
	}
});
export const cancel = mutation({
	args: { request: v.optional(v.object({ id: v.id('companyDeletions'), attemptId: v.string() })) },
	returns: v.union(
		v.literal('cancelled'),
		v.literal('none'),
		v.literal('superseded'),
		v.literal('dispatched')
	),
	handler: async (ctx, args) => {
		const profile = await requireProfile(ctx);
		const marker = await ctx.db
			.query('companyDeletions')
			.withIndex('by_issuer_and_clerkId', (q) =>
				q.eq('issuer', profile.issuer).eq('clerkId', profile.clerkId)
			)
			.unique();
		if (!marker) return 'none' as const;
		if (
			args.request &&
			(marker._id !== args.request.id || marker.attemptId !== args.request.attemptId)
		)
			return 'superseded' as const;
		if (marker.status !== 'prepared') return 'dispatched' as const;
		await ctx.db.delete('companyDeletions', marker._id);
		return 'cancelled' as const;
	}
});
async function markDeleted(ctx: MutationCtx, issuer: string, clerkId: string) {
	let marker = await ctx.db
		.query('deletedUsers')
		.withIndex('by_issuer_and_clerkId', (q) => q.eq('issuer', issuer).eq('clerkId', clerkId))
		.unique();
	if (!marker) {
		const profile = await ctx.db
			.query('profiles')
			.withIndex('by_issuer_and_clerkId', (q) => q.eq('issuer', issuer).eq('clerkId', clerkId))
			.unique();
		const markerId = await ctx.db.insert('deletedUsers', {
			issuer,
			clerkId,
			profileId: profile?._id,
			deletedAt: Date.now(),
			complete: !profile
		});
		marker = await ctx.db.get('deletedUsers', markerId);
	}
	if (marker) await ensureCleanup(ctx, marker);
	await confirmAccountDeletion(ctx, issuer, clerkId);
	return null;
}
export const mark = internalMutation({
	args: { issuer: v.string(), clerkId: v.string() },
	returns: v.null(),
	handler: (ctx, { issuer, clerkId }) => markDeleted(ctx, issuer, clerkId)
});
export const markMany = internalMutation({
	args: { identities: v.array(v.object({ issuer: v.string(), clerkId: v.string() })) },
	returns: v.null(),
	handler: async (ctx, { identities }) => {
		if (identities.length > 25) throw new ConvexError('Account reconciliation batch is too large.');
		for (const identity of identities) {
			try {
				await ctx.runMutation(internal.accountDeletion.mark, identity);
			} catch (error) {
				console.error('Unable to record reconciled account deletion', identity.clerkId, error);
			}
		}
		return null;
	}
});
export const resume = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('deletedUsers')
			.withIndex('by_complete', (q) => q.eq('complete', false))
			.paginate({ cursor: cursor ?? null, numItems: 10 });
		for (const marker of result.page) {
			try {
				await ctx.runMutation(internal.accountDeletion.resumeOne, { markerId: marker._id });
			} catch (error) {
				console.error('Unable to resume account deletion', marker._id, error);
			}
		}
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.accountDeletion.resume, {
				cursor: result.continueCursor
			});
		return null;
	}
});
export const resumeOne = internalMutation({
	args: { markerId: v.id('deletedUsers') },
	returns: v.null(),
	handler: async (ctx, { markerId }) => {
		const marker = await ctx.db.get('deletedUsers', markerId);
		if (marker) await ensureCleanup(ctx, marker);
		return null;
	}
});
export const clean = internalMutation({
	args: { markerId: v.id('deletedUsers'), generation: v.number() },
	returns: v.null(),
	handler: async (ctx, { markerId, generation }) => {
		const marker = await ctx.db.get('deletedUsers', markerId);
		// A retried or superseded cleanup job cannot continue an older chain.
		if (!marker || marker.complete || generation !== marker.cleanupGeneration) return null;
		if (marker.profileId) {
			const profileId = marker.profileId;
			const membership = await ctx.db
				.query('memberships')
				.withIndex('by_profileId', (q) => q.eq('profileId', profileId))
				.unique();
			const owned = await ctx.db
				.query('company')
				.withIndex('by_ownerProfileId', (q) => q.eq('ownerProfileId', profileId))
				.first();
			if (owned && !(await companyDeletion(ctx, owned._id))) {
				const candidates = await ctx.db
					.query('memberships')
					.withIndex('by_companyId', (q) => q.eq('companyId', owned._id))
					.paginate({ cursor: marker.successorCursor ?? null, numItems: 25 });
				let successor;
				for (const candidate of candidates.page) {
					if (
						candidate.profileId !== profileId &&
						!(await creatorDeleted(ctx, candidate.profileId))
					) {
						successor = candidate;
						break;
					}
				}
				if (!successor && !candidates.isDone) {
					await ctx.db.patch('deletedUsers', marker._id, {
						successorCursor: candidates.continueCursor
					});
					await scheduleCleanup(ctx, marker);
					return null;
				}
				await ctx.db.patch('company', owned._id, { ownerProfileId: successor?.profileId });
			}
			if (membership) await ctx.db.delete('memberships', membership._id);
			const profile = await ctx.db.get('profiles', marker.profileId);
			if (profile?.avatarId) await ctx.storage.delete(profile.avatarId);
			if (profile) await ctx.db.delete('profiles', profile._id);
		}
		await ctx.db.patch('deletedUsers', markerId, { complete: true, cleanupJobId: undefined });
		return null;
	}
});
export const registered = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({
		page: v.array(v.object({ issuer: v.string(), clerkId: v.string() })),
		cursor: v.string(),
		done: v.boolean()
	}),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query('profiles').paginate({ cursor, numItems: 25 });
		return {
			page: result.page.map(({ issuer, clerkId }) => ({ issuer, clerkId })),
			cursor: result.continueCursor,
			done: result.isDone
		};
	}
});
