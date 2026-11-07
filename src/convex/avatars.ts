import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { requirePermission, requireProfile } from './auth';
import { deleteUnownedFile } from './storageOwnership';

async function requireAvatarTarget(
	ctx: QueryCtx,
	company: boolean,
	membershipId?: import('./_generated/dataModel').Id<'memberships'>
) {
	return company
		? {
				table: 'company' as const,
				record: (await requirePermission(ctx, 'editCompanyProfile', membershipId)).company
			}
		: { table: 'profiles' as const, record: await requireProfile(ctx) };
}

export const authorizeAvatarUpload = internalQuery({
	args: { company: v.boolean(), membershipId: v.optional(v.id('memberships')) },
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireAvatarTarget(ctx, args.company, args.membershipId);
		return null;
	}
});

export const setAvatar = internalMutation({
	args: {
		avatarId: v.id('_storage'),
		company: v.boolean(),
		membershipId: v.optional(v.id('memberships'))
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Reauthorize in the committing transaction; the role may change during upload.
		const { table, record } = await requireAvatarTarget(ctx, args.company, args.membershipId);
		if (record.avatarId === args.avatarId) return null;
		if (!(await ctx.db.system.get('_storage', args.avatarId)))
			throw new Error('Avatar file is unavailable.');
		await ctx.db.patch(table, record._id, { avatarId: args.avatarId });
		if (record.avatarId) await deleteUnownedFile(ctx, record.avatarId);
		return null;
	}
});
