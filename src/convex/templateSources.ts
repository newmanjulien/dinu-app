import { v } from 'convex/values';
import { sourceBlock } from '../lib/document/source-validators';
import { query } from './_generated/server';
import { requireMembership } from './auth';
import { templateSourceBlocks, readTemplateSource } from './templateSourceStorage';

export const blocks = query({
	args: { membershipId: v.id('memberships') },
	returns: v.array(sourceBlock),
	handler: async (ctx, args) => {
		const { companyId, company } = await requireMembership(ctx, args.membershipId);
		return company.templateSourceId
			? templateSourceBlocks(ctx, company.templateSourceId, companyId)
			: [];
	}
});

/** Source and fingerprint are accepted together, including reviewed template source repairs. */
export const authoringSource = query({
	args: { membershipId: v.id('memberships') },
	returns: v.object({ templateSourceFingerprint: v.string(), blocks: v.array(sourceBlock) }),
	handler: async (ctx, { membershipId }) => {
		const { companyId, company } = await requireMembership(ctx, membershipId);
		if (!company.templateSourceId) return { templateSourceFingerprint: '', blocks: [] };
		const source = await readTemplateSource(ctx, company.templateSourceId, companyId);
		return { templateSourceFingerprint: source.templateSource.fingerprint, blocks: source.blocks };
	}
});
