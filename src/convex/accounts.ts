import { paginationResultValidator } from 'convex/server';
import { v } from 'convex/values';
import { query, type QueryCtx } from './_generated/server';
import { viewerResult } from './accountViews';
import { companyDeletion, membershipForProfile, readAccount } from './auth';
import { readDirectory } from './contractDirectory';
import { hasInvitedColleagues } from './invitationDeliverySummary';
import { permissionsForRole } from './permissions';
import { contractCard } from './savedContractValidators';

export async function readViewer(ctx: QueryCtx) {
	const { identity, profile } = await readAccount(ctx);
	if (!profile) return null;
	const membership = await membershipForProfile(ctx, profile._id);
	const company = membership ? await ctx.db.get('company', membership.companyId) : null;
	const [profileAvatar, companyAvatar, deletion, instruction, colleaguesInvited] =
		await Promise.all([
			profile.avatarId ? ctx.storage.getUrl(profile.avatarId) : null,
			company?.avatarId ? ctx.storage.getUrl(company.avatarId) : null,
			company ? companyDeletion(ctx, company._id) : null,
			company?.baselineId
				? ctx.db
						.query('playbookItems')
						.withIndex('by_companyId', (q) => q.eq('companyId', company._id))
						.first()
				: null,
			company ? hasInvitedColleagues(ctx, company) : false
		]);
	const isOwner = company?.ownerProfileId === profile._id;
	const role = membership && company ? membership.role : 'rep';
	return {
		profile: {
			id: profile._id,
			name: profile.name,
			email: identity.email,
			avatarUrl: profileAvatar
		},
		membership:
			membership && company
				? { id: membership._id, companyId: company._id, role: membership.role, isOwner }
				: null,
		company: company
			? {
					id: company._id,
					name: company.name,
					avatarUrl: companyAvatar,
					approvalEmail: company.approvalEmail ?? null,
					csmCallBooked: company.csmCallBookedAt !== undefined,
					deletionPending: Boolean(deletion)
				}
			: null,
		permissions: permissionsForRole(membership && company ? role : 'rep', isOwner),
		needsInitialization: profile.email !== identity.email.trim().toLowerCase(),
		templateReady: Boolean(company?.baselineId),
		instructionsReady: Boolean(instruction),
		colleaguesInvited
	};
}

export const viewer = query({
	args: {},
	returns: viewerResult,
	handler: readViewer
});

export const startup = query({
	args: {},
	returns: v.object({
		viewer: viewerResult,
		contracts: v.union(paginationResultValidator(contractCard), v.null())
	}),
	handler: async (ctx) => {
		const viewer = await readViewer(ctx);
		const company =
			viewer?.membership && !viewer.needsInitialization && !viewer.company?.deletionPending
				? viewer.company
				: null;
		return {
			viewer,
			contracts: company
				? await readDirectory(ctx, company.id, '', { cursor: null, numItems: 24 })
				: null
		};
	}
});
