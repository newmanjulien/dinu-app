import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { v } from 'convex/values';
import { textPrefix } from '../lib/text';
import { mutation, query } from './_generated/server';
import { memberView } from './accountViews';
import { liveProfile, readAccount, requireMembership, requireProfile } from './auth';
import { normalizedName } from './names';

export const initialize = mutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const { identity, profile } = await readAccount(ctx);
		const email = identity.email.trim().toLowerCase();
		if (profile) {
			if (profile.email !== email) await ctx.db.patch('profiles', profile._id, { email });
		} else
			await ctx.db.insert('profiles', {
				identity: identity.tokenIdentifier,
				issuer: identity.issuer,
				clerkId: identity.subject,
				email,
				name: textPrefix((identity.name ?? '').trim(), 32)
			});
		return null;
	}
});
export const colleagues = query({
	args: { membershipId: v.id('memberships'), paginationOpts: paginationOptsValidator },
	returns: paginationResultValidator(memberView),
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
							role: member.role,
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

export const setName = mutation({
	args: { name: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const profile = await requireProfile(ctx);
		const value = normalizedName(args.name);
		if (profile.name !== value) await ctx.db.patch('profiles', profile._id, { name: value });
		return null;
	}
});

export { startup, viewer } from './legacyAccounts';
