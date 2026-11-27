import { v } from 'convex/values';
import { sourceBlock } from '../lib/document/source-validators';
import { query } from './_generated/server';
import { requireMembership } from './auth';
import { readTemplateSource } from './templateSourceStorage';

/** Source and fingerprint are accepted together, including reviewed template source repairs. */
export const authoringSource = query({
	args: {},
	returns: v.object({ templateSourceFingerprint: v.string(), blocks: v.array(sourceBlock) }),
	handler: async (ctx) => {
		const { companyId, company } = await requireMembership(ctx);
		if (!company.templateSourceId) return { templateSourceFingerprint: '', blocks: [] };
		const source = await readTemplateSource(ctx, company.templateSourceId, companyId);
		return { templateSourceFingerprint: source.templateSource.fingerprint, blocks: source.blocks };
	}
});
