import { requireMembership } from './auth';
import { v } from 'convex/values';
import { query } from './_generated/server';
import { baselineBlock as contractBlock } from './sourceValidators';
import { currentPointer } from './templates';
import { baselineBlocks } from './baselineStorage';

export const getBlocks = query({
	args: { membershipId: v.id('memberships') },
	returns: v.array(contractBlock),
	handler: async (ctx, args) => {
		const { companyId } = await requireMembership(ctx, args.membershipId);
		const pointer = await currentPointer(ctx, companyId);
		return pointer ? baselineBlocks(ctx, pointer.baselineId, companyId) : [];
	}
});
