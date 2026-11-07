import { v } from 'convex/values';
import { baselineBlock } from '../lib/contract/source-validators';
import { query } from './_generated/server';
import { requireMembership } from './auth';
import { baselineBlocks, readBaseline } from './baselineStorage';

export const blocks = query({
	args: { membershipId: v.id('memberships') },
	returns: v.array(baselineBlock),
	handler: async (ctx, args) => {
		const { companyId, company } = await requireMembership(ctx, args.membershipId);
		return company.baselineId ? baselineBlocks(ctx, company.baselineId, companyId) : [];
	}
});

/** Source and fingerprint are accepted together, including reviewed baseline repairs. */
export const authoringSource = query({
	args: { membershipId: v.id('memberships') },
	returns: v.object({ baselineFingerprint: v.string(), blocks: v.array(baselineBlock) }),
	handler: async (ctx, { membershipId }) => {
		const { companyId, company } = await requireMembership(ctx, membershipId);
		if (!company.baselineId) return { baselineFingerprint: '', blocks: [] };
		const source = await readBaseline(ctx, company.baselineId, companyId);
		return { baselineFingerprint: source.baseline.fingerprint, blocks: source.blocks };
	}
});
