import { ConvexError, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation, mutation, type MutationCtx } from './_generated/server';
import {
	liveProfile,
	membershipForProfile,
	requireAccount,
	requireCompany,
	requireMembership,
	requirePermission
} from './auth';
import { revokeInvitation } from './companyInvitations';
import { emailAddress } from './emailValidators';
import { normalizedName } from './names';
import { deleteUnownedFile } from './storageOwnership';
export const create = mutation({
	args: { name: v.string() },
	returns: v.id('company'),
	handler: async (ctx, args) => {
		const { identity, profile } = await requireAccount(ctx);
		if (await membershipForProfile(ctx, profile._id))
			throw new ConvexError('Leave your current company before creating another.');
		const name = args.name.trim();
		if (!name || name.length > 120)
			throw new ConvexError('Enter a company name of 120 characters or fewer.');
		const companyId = await ctx.db.insert('company', {
			name,
			ownerProfileId: profile._id,
			approvalEmail: identity.email.trim().toLowerCase()
		});
		await ctx.db.insert('memberships', { companyId, profileId: profile._id, role: 'admin' });
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
			if (invitation) await revokeInvitation(ctx, invitation);
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
		if (!(await liveProfile(ctx, target.profileId)))
			throw new ConvexError('This colleague is unavailable.');
		await ctx.db.patch('memberships', target._id, { role: 'admin' });
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
	args: { companyId: v.id('company'), profileId: v.id('profiles') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const company = await requireCompany(ctx, args.companyId);
		const replacement = await liveProfile(ctx, args.profileId);
		if (!replacement) throw new ConvexError('Recovery requires a live replacement owner.');
		const priorOwnerId = company.ownerProfileId;
		if (priorOwnerId && (await liveProfile(ctx, priorOwnerId)))
			throw new ConvexError('Recovery requires a deleted or missing company owner.');
		const replacementMembership = await membershipForProfile(ctx, replacement._id);
		if (replacementMembership && replacementMembership.companyId !== company._id)
			throw new ConvexError('The replacement owner already belongs to another company.');
		if (replacementMembership) {
			await ctx.db.patch('memberships', replacementMembership._id, { role: 'admin' });
		} else {
			await ctx.db.insert('memberships', {
				companyId: company._id,
				profileId: replacement._id,
				role: 'admin'
			});
		}
		await ctx.db.patch('company', company._id, { ownerProfileId: replacement._id });
		if (!priorOwnerId) return null;
		const marker = await ctx.db
			.query('deletedUsers')
			.withIndex('by_profileId', (q) => q.eq('profileId', priorOwnerId))
			.unique();
		if (!marker || marker.complete || marker.recoveryCompanyId !== company._id) return null;
		const membership = await membershipForProfile(ctx, priorOwnerId);
		if (membership?.companyId === company._id) await ctx.db.delete('memberships', membership._id);
		const profile = await ctx.db.get('profiles', priorOwnerId);
		if (profile) await ctx.db.delete('profiles', profile._id);
		if (profile?.avatarId) await deleteUnownedFile(ctx, profile.avatarId);
		await ctx.db.patch('deletedUsers', marker._id, {
			complete: true,
			cleanupJobId: undefined,
			recoveryCompanyId: undefined
		});
		return null;
	}
});

export const setName = mutation({
	args: { membershipId: v.id('memberships'), name: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requirePermission(ctx, 'editCompanyProfile', args.membershipId);
		const value = normalizedName(args.name, 120);
		if (access.company.name !== value)
			await ctx.db.patch('company', access.companyId, { name: value });
		return null;
	}
});

export const setApprovalEmail = mutation({
	args: { membershipId: v.id('memberships'), email: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requirePermission(ctx, 'editCompanyProfile', args.membershipId);
		const email = emailAddress(args.email);
		if (access.company.approvalEmail !== email)
			await ctx.db.patch('company', access.companyId, { approvalEmail: email });
		return null;
	}
});
