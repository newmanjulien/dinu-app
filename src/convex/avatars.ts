import { ConvexError, v } from 'convex/values';
import { mutation, type QueryCtx } from './_generated/server';
import { requirePermission, requireMembership } from './auth';
import { deleteUnownedFile } from './storageOwnership';
const uploadArgs = { company: v.boolean(), membershipId: v.id('memberships') };
async function requireAvatarTarget(
	ctx: QueryCtx,
	company: boolean,
	membershipId: import('./_generated/dataModel').Id<'memberships'>
) {
	const access = company
		? await requirePermission(ctx, 'editCompanyProfile', membershipId)
		: await requireMembership(ctx, membershipId);
	return company
		? { table: 'company' as const, record: access.company }
		: { table: 'profiles' as const, record: access.profile };
}
export const generateUploadUrl = mutation({
	args: uploadArgs,
	returns: v.string(),
	handler: async (ctx, args) => {
		await requireAvatarTarget(ctx, args.company, args.membershipId);
		return ctx.storage.generateUploadUrl();
	}
});
export const commitAvatar = mutation({
	args: { ...uploadArgs, avatarId: v.id('_storage') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const { table, record } = await requireAvatarTarget(ctx, args.company, args.membershipId);
		const file = await ctx.db.system.get('_storage', args.avatarId);
		if (
			!file ||
			file.size > 2 * 1024 * 1024 ||
			!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(
				file.contentType ?? ''
			)
		)
			throw new ConvexError('Choose an image of 2 MB or less (JPEG, PNG, WebP, GIF or AVIF).');
		if (record.avatarId === args.avatarId) return null;
		await ctx.db.patch(table, record._id, { avatarId: args.avatarId });
		if (record.avatarId) await deleteUnownedFile(ctx, record.avatarId);
		return null;
	}
});
