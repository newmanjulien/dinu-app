import { ConvexError, v } from 'convex/values';
import { mutation } from './_generated/server';
import { accessibleContract, requireMembership } from './auth';
import { linkFor } from './buyerCurrent';

function validVisitId(visitId: string) {
	if (!visitId || visitId.length > 100) throw new ConvexError('Invalid visit.');
}

/** Claim one showing per member and unlinked contract. A retry from the same visit keeps its claim. */
export const claimBuyerLinkBarShowing = mutation({
	args: {
		membershipId: v.id('memberships'),
		contractId: v.id('savedContracts'),
		visitId: v.string()
	},
	returns: v.boolean(),
	handler: async (ctx, { membershipId, contractId, visitId }) => {
		validVisitId(visitId);
		const access = await requireMembership(ctx, membershipId);
		const contract = accessibleContract(await ctx.db.get('savedContracts', contractId), access);
		if (!contract) throw new ConvexError('This contract is unavailable.');
		const cleanup = await ctx.db
			.query('contractCleanups')
			.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
			.unique();
		if (cleanup) throw new ConvexError('This contract is unavailable.');
		const prior = await ctx.db
			.query('buyerLinkBarShowings')
			.withIndex('by_membershipId_and_contractId', (q) =>
				q.eq('membershipId', access.membershipId).eq('contractId', contractId)
			)
			.unique();
		if (prior) return prior.visitId === visitId;
		if (await linkFor(ctx, contractId)) return false;
		await ctx.db.insert('buyerLinkBarShowings', {
			membershipId: access.membershipId,
			companyId: access.companyId,
			contractId,
			visitId,
			shownAt: Date.now()
		});
		return true;
	}
});

/** Claim the dashboard hint when this member has created their first active buyer link. */
export const claimFirstBuyerLinkHintShowing = mutation({
	args: { membershipId: v.id('memberships'), visitId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, { membershipId, visitId }) => {
		validVisitId(visitId);
		const access = await requireMembership(ctx, membershipId);
		if (access.membership.firstBuyerLinkHintShowing)
			return access.membership.firstBuyerLinkHintShowing.visitId === visitId;
		const ownLinks = await ctx.db
			.query('buyerLinks')
			.withIndex('by_companyId_and_creatorId', (q) =>
				q.eq('companyId', access.companyId).eq('creatorId', access.profile._id)
			)
			.take(2);
		if (ownLinks.length !== 1 || !ownLinks[0].currentView) return false;
		await ctx.db.patch('memberships', access.membershipId, {
			firstBuyerLinkHintShowing: { visitId, shownAt: Date.now() }
		});
		return true;
	}
});
