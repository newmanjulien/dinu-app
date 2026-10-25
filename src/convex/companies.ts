import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation, type MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import {
	requireProfile,
	requireMembership,
	requirePermission,
	creatorDeleted,
	verifiedIdentity,
	requireCompany
} from './auth';
export const create = mutation({
	args: { name: v.string() },
	returns: v.id('company'),
	handler: async (ctx, args) => {
		const profile = await requireProfile(ctx);
		if (
			await ctx.db
				.query('memberships')
				.withIndex('by_profileId', (q) => q.eq('profileId', profile._id))
				.unique()
		)
			throw new ConvexError('Leave your current company before creating another.');
		const name = args.name.trim();
		if (!name || name.length > 120)
			throw new ConvexError('Enter a company name of 120 characters or fewer.');
		const companyId = await ctx.db.insert('company', {
			name,
			contractDirectoryReady: true,
			ownerProfileId: profile._id,
			approvalEmail: (await verifiedIdentity(ctx)).email!.trim().toLowerCase()
		});
		await ctx.db.insert('memberships', { companyId, profileId: profile._id });
		await ctx.db.patch('profiles', profile._id, { role: 'admin' });
		return companyId;
	}
});
async function targetMember(
	ctx: MutationCtx,
	access: Awaited<ReturnType<typeof requireMembership>>,
	id: Doc<'memberships'>['_id']
) {
	const target = await ctx.db.get('memberships', id);
	if (!target || target.companyId !== access.companyId)
		throw new ConvexError('This colleague is unavailable.');
	return target;
}
export const removeMember = mutation({
	args: { membershipId: v.id('memberships'), targetMembershipId: v.id('memberships') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requirePermission(ctx, 'manageMembers', args.membershipId);
		const target = await targetMember(ctx, access, args.targetMembershipId);
		if (target.profileId === access.company.ownerProfileId)
			throw new ConvexError('The owner must transfer ownership first.');
		if (target._id === access.membershipId) throw new ConvexError('Use Leave company to leave.');
		const profile = await ctx.db.get('profiles', target.profileId);
		if (profile) {
			const invitation = await ctx.db
				.query('companyInvitations')
				.withIndex('by_companyId_and_normalizedEmail_and_status', (q) =>
					q
						.eq('companyId', access.companyId)
						.eq('normalizedEmail', profile.email.trim().toLowerCase())
						.eq('status', 'pending')
				)
				.unique();
			if (invitation)
				await ctx.db.patch('companyInvitations', invitation._id, {
					status: 'revoked',
					deliveryGeneration: invitation.deliveryGeneration + 1
				});
		}
		await ctx.db.delete('memberships', target._id);
		return null;
	}
});
export const transferOwnership = mutation({
	args: { membershipId: v.id('memberships'), targetMembershipId: v.id('memberships') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requirePermission(ctx, 'manageOwnership', args.membershipId);
		const target = await targetMember(ctx, access, args.targetMembershipId);
		if (await creatorDeleted(ctx, target.profileId))
			throw new ConvexError('This colleague is unavailable.');
		await ctx.db.patch('company', access.companyId, { ownerProfileId: target.profileId });
		return null;
	}
});
export const leave = mutation({
	args: { membershipId: v.id('memberships') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		if (access.isOwner) throw new ConvexError('Transfer ownership to a colleague before leaving.');
		await ctx.db.delete('memberships', access.membershipId);
		return null;
	}
});

export const recoverOwner = internalMutation({
	args: { companyId: v.id('company'), membershipId: v.id('memberships') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const company = await requireCompany(ctx, args.companyId);
		const member = await ctx.db.get('memberships', args.membershipId);
		if (
			company.ownerProfileId ||
			!member ||
			member.companyId !== company._id ||
			(await creatorDeleted(ctx, member.profileId))
		)
			throw new ConvexError(
				'Recovery requires an ownerless company and a live colleague in that company.'
			);
		await ctx.db.patch('company', company._id, { ownerProfileId: member.profileId });
		return null;
	}
});
