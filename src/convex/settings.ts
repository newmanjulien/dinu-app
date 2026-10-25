import { emailAddress } from './emailValidators';
import { v, ConvexError } from 'convex/values';
import { mutation, internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { requirePermission, requireProfile } from './auth';
import { role } from './permissions';
function name(value: string, max = 32) {
	const result = value.trim();
	if (!result || result.length > max)
		throw new ConvexError(`Name must be between 1 and ${max} characters.`);
	return result;
}
export const savePersonalName = mutation({
	args: { name: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const profile = await requireProfile(ctx);
		await ctx.db.patch('profiles', profile._id, { name: name(args.name) });
		return null;
	}
});
export const savePersonalRole = mutation({
	args: { role },
	returns: v.null(),
	handler: async (ctx, args) => {
		const profile = await requireProfile(ctx);
		await ctx.db.patch('profiles', profile._id, { role: args.role });
		return null;
	}
});
export const saveCompanyName = mutation({
	args: { membershipId: v.id('memberships'), name: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requirePermission(ctx, 'editCompanyProfile', args.membershipId);
		await ctx.db.patch('company', access.companyId, { name: name(args.name, 120) });
		return null;
	}
});

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
		if (record.avatarId) await ctx.storage.delete(record.avatarId);
		await ctx.db.patch(table, record._id, { avatarId: args.avatarId });
		return null;
	}
});

export const saveApprovalEmail = mutation({
	args: { membershipId: v.id('memberships'), email: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requirePermission(ctx, 'editCompanyProfile', args.membershipId);
		const email = emailAddress(args.email);
		await ctx.db.patch('company', access.companyId, { approvalEmail: email });
		return null;
	}
});
