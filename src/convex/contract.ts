import { requireMembership } from './auth';
import { v } from 'convex/values';
import { query } from './_generated/server';
import { baselineBlock as contractBlock } from './sourceValidators';
import { baselineBlocks } from './baselineStorage';

export const getBlocks = query({
	args: { membershipId: v.id('memberships') },
	returns: v.array(contractBlock),
	handler: async (ctx, args) => {
		const { companyId, company } = await requireMembership(ctx, args.membershipId);
		return company.baselineId ? baselineBlocks(ctx, company.baselineId, companyId) : [];
	}
});
