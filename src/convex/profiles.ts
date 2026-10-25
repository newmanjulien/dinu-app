import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { v, ConvexError } from 'convex/values';
import { query, mutation, type QueryCtx } from './_generated/server';
import { requireMembership, verifiedIdentity, liveProfile, companyDeletion } from './auth';
import { permissions, permissionsForRole, role } from './permissions';
import { contractCard } from './savedContractValidators';
import { readDirectory } from './contractDirectory';
export const profileView = v.object({
	id: v.id('profiles'),
	name: v.string(),
	email: v.string(),
	role,
	avatarUrl: v.union(v.string(), v.null())
});
export const viewerResult = v.union(
	v.null(),
	v.object({
		profile: profileView,
		permissions,
		membership: v.union(
			v.null(),
			v.object({
				id: v.id('memberships'),
				companyId: v.id('company'),
				isOwner: v.boolean()
			})
		),
		company: v.union(
			v.null(),
			v.object({
				id: v.id('company'),
				name: v.string(),
				avatarUrl: v.union(v.string(), v.null()),
				approvalEmail: v.union(v.string(), v.null()),
				deletionPending: v.boolean(),
				contractDirectoryReady: v.optional(v.boolean())
			})
		),
		needsInitialization: v.boolean(),
		templateReady: v.boolean()
	})
);

export async function readViewer(ctx: QueryCtx) {
	const identity = await verifiedIdentity(ctx);
	const deleted = await ctx.db
		.query('deletedUsers')
		.withIndex('by_issuer_and_clerkId', (q) =>
			q.eq('issuer', identity.issuer).eq('clerkId', identity.subject)
		)
		.unique();
	if (deleted) throw new ConvexError('This account has been deleted.');
	const profile = await ctx.db
		.query('profiles')
		.withIndex('by_identity', (q) => q.eq('identity', identity.tokenIdentifier))
		.unique();
	if (!profile) return null;
	const membership = await ctx.db
		.query('memberships')
		.withIndex('by_profileId', (q) => q.eq('profileId', profile._id))
		.unique();
	const company = membership ? await ctx.db.get('company', membership.companyId) : null;
	const [pointer, profileAvatar, companyAvatar, deletion] = await Promise.all([
		company
			? ctx.db
					.query('currentTemplate')
					.withIndex('by_companyId', (q) => q.eq('companyId', company._id))
					.unique()
			: null,
		profile.avatarId ? ctx.storage.getUrl(profile.avatarId) : null,
		company?.avatarId ? ctx.storage.getUrl(company.avatarId) : null,
		company ? companyDeletion(ctx, company._id) : null
	]);
	const isOwner = company?.ownerProfileId === profile._id;
	return {
		profile: {
			id: profile._id,
			name: profile.name,
			email: identity.email!,
			role: profile.role,
			avatarUrl: profileAvatar
		},
		membership:
			membership && company ? { id: membership._id, companyId: company._id, isOwner } : null,
		company: company
			? {
					id: company._id,
					name: company.name,
					avatarUrl: companyAvatar,
					approvalEmail: company.approvalEmail ?? null,
					deletionPending: Boolean(deletion),
					contractDirectoryReady: Boolean(company.contractDirectoryReady)
				}
			: null,
		permissions: permissionsForRole(membership && company ? profile.role : 'rep', isOwner),
		needsInitialization: profile.email !== identity.email!.trim().toLowerCase(),
		templateReady: Boolean(pointer?.versionId && !pointer.maintenance)
	};
}

export const viewer = query({
	args: {},
	returns: viewerResult,
	handler: readViewer
});

export const startup = query({
	args: {},
	returns: v.object({
		viewer: viewerResult,
		contracts: v.union(paginationResultValidator(contractCard), v.null())
	}),
	handler: async (ctx) => {
		const viewer = await readViewer(ctx);
		const company =
			viewer?.membership && !viewer.needsInitialization && !viewer.company?.deletionPending
				? viewer.company
				: null;
		return {
			viewer,
			contracts: company
				? await readDirectory(
						ctx,
						{ _id: company.id, contractDirectoryReady: company.contractDirectoryReady },
						'',
						{ cursor: null, numItems: 24 }
					)
				: null
		};
	}
});
export const initialize = mutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const identity = await verifiedIdentity(ctx);
		if (
			await ctx.db
				.query('deletedUsers')
				.withIndex('by_issuer_and_clerkId', (q) =>
					q.eq('issuer', identity.issuer).eq('clerkId', identity.subject)
				)
				.unique()
		)
			throw new ConvexError('This account has been deleted.');
		const profile = await ctx.db
			.query('profiles')
			.withIndex('by_identity', (q) => q.eq('identity', identity.tokenIdentifier))
			.unique();
		const email = identity.email!.trim().toLowerCase();
		if (profile) await ctx.db.patch('profiles', profile._id, { email });
		else
			await ctx.db.insert('profiles', {
				identity: identity.tokenIdentifier,
				issuer: identity.issuer,
				clerkId: identity.subject,
				email,
				name: (identity.name ?? '').trim().slice(0, 32),
				role: 'rep'
			});
		return null;
	}
});
export const colleagues = query({
	args: { membershipId: v.id('memberships'), paginationOpts: paginationOptsValidator },
	returns: paginationResultValidator(
		profileView.extend({ membershipId: v.id('memberships'), isOwner: v.boolean() })
	),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const result = await ctx.db
			.query('memberships')
			.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
			.paginate(args.paginationOpts);
		const hydrated = await Promise.all(
			result.page.map(async (member) => {
				const profile = await liveProfile(ctx, member.profileId);
				return profile
					? {
							id: profile._id,
							name: profile.name,
							email: profile.email,
							role: profile.role,
							avatarUrl: profile.avatarId ? await ctx.storage.getUrl(profile.avatarId) : null,
							membershipId: member._id,
							isOwner: access.company.ownerProfileId === profile._id
						}
					: null;
			})
		);
		const page = hydrated.filter((profile) => profile !== null);
		return { ...result, page };
	}
});
