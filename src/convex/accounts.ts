import { paginationResultValidator } from 'convex/server';
import { v } from 'convex/values';
import { mutation, query, type QueryCtx } from './_generated/server';
import { uiPreferencesView, viewerResult } from './accountViews';
import { membershipForProfile, readAccount, requireMembership, type CompanyAccess } from './auth';
import { hasActiveLinkForCreator } from './buyerLinks';
import { readDirectory } from './contractDirectory';
import { resolveSetupBooking, setupCallFor } from './csmSetupState';
import { installation, lifecycle } from './hubspotInstallation';
import { hasInvitedColleagues } from './invitationDeliverySummary';
import { completeMembershipSetup, readMembershipSetup } from './membershipSetupState';
import { supportWidgetCollapsed } from './membershipUiPreferences';
import { permissionsForRole } from './permissions';
import { readHelpPreferences } from './profileUiPreferences';
import { contractCard } from './savedContractValidators';

async function viewerAccount(ctx: QueryCtx) {
	const { identity, profile } = await readAccount(ctx);
	const membership = profile ? await membershipForProfile(ctx, profile._id) : null;
	const company = membership ? await ctx.db.get('company', membership.companyId) : null;
	return { identity, profile, membership, company };
}
export async function readViewer(
	ctx: QueryCtx,
	account?: Awaited<ReturnType<typeof viewerAccount>>
) {
	const { identity, profile, membership, company } = account ?? (await viewerAccount(ctx));
	if (!profile) return null;
	const isOwner = company?.ownerProfileId === profile._id;
	const memberRole = membership && company ? membership.role : 'rep';
	const viewerPermissions = permissionsForRole(memberRole, isOwner);
	const deletion = company?.deletion;
	const [profileAvatar, companyAvatar, setupBooking] = await Promise.all([
		profile.avatarId ? ctx.storage.getUrl(profile.avatarId) : null,
		company?.avatarId ? ctx.storage.getUrl(company.avatarId) : null,
		company && viewerPermissions.manageTemplate && !company.templateSourceId
			? resolveSetupBooking(ctx, company)
			: null
	]);
	return {
		profile: {
			id: profile._id,
			name: profile.name,
			email: identity.email,
			avatarUrl: profileAvatar
		},
		membership:
			membership && company
				? {
						id: membership._id,
						companyId: company._id,
						role: membership.role,
						isOwner
					}
				: null,
		company: company
			? {
					id: company._id,
					name: company.name,
					avatarUrl: companyAvatar,
					approvalEmail: company.approvalEmail ?? null,
					setupCall: setupCallFor(setupBooking),
					templateSource:
						company.templateSourceId && company.templateSourceFingerprint
							? { id: company.templateSourceId, fingerprint: company.templateSourceFingerprint }
							: null,
					deletion: deletion
						? {
								status:
									deletion.status === 'deleting'
										? deletion.inFlight
											? ('inProgress' as const)
											: ('deleting' as const)
										: ('cleaning' as const),
								ownedByViewer:
									deletion.issuer === profile.issuer && deletion.clerkId === profile.clerkId
							}
						: null
				}
			: null,
		permissions: viewerPermissions,
		needsInitialization: profile.email !== identity.email.trim().toLowerCase(),
		templateReady: Boolean(company?.templateSourceId),
		instructionsReady: Boolean(company?.hasRepInstructions)
	};
}

export const viewer = query({
	args: {},
	returns: viewerResult,
	handler: (ctx) => readViewer(ctx)
});

export const uiPreferences = query({
	args: {},
	returns: uiPreferencesView,
	handler: async (ctx) => {
		const { profile, membership } = await requireMembership(ctx);
		const [helpPreferences, collapsed] = await Promise.all([
			readHelpPreferences(ctx, profile),
			supportWidgetCollapsed(ctx, membership)
		]);
		return { helpPreferences, supportWidgetCollapsed: collapsed };
	}
});

const scope = v.object({
	profileId: v.id('profiles'),
	membershipId: v.id('memberships'),
	companyId: v.id('company')
});
const homeView = v.object({
	scope,
	search: v.literal(''),
	cursor: v.null(),
	numItems: v.literal(24),
	contracts: paginationResultValidator(contractCard)
});
const setupStep = v.union(
	v.literal('template'),
	v.literal('instructions'),
	v.literal('contract'),
	v.literal('buyer-link'),
	v.literal('integrations'),
	v.literal('team'),
	v.null()
);
const setupProgress = v.object({
	complete: v.boolean(),
	nextStep: setupStep,
	contractId: v.union(v.id('savedContracts'), v.null())
});

/** One authoritative checklist for the workspace prompt and support experience. */
async function readSetupProgress(
	ctx: QueryCtx,
	access: CompanyAccess,
	setup?: Awaited<ReturnType<typeof readMembershipSetup>>
) {
	const { setupCompletedAt } = setup ?? (await readMembershipSetup(ctx, access.membership));
	const result = (
		nextStep: typeof setupStep.type,
		contractId: import('./_generated/dataModel').Id<'savedContracts'> | null = null
	) => ({
		complete: setupCompletedAt !== undefined,
		nextStep,
		contractId
	});
	if (setupCompletedAt !== undefined) return result(null);
	if (!access.company.templateSourceId) return result('template');
	if (!access.company.hasRepInstructions) return result('instructions');
	const contract = await ctx.db
		.query('contractDirectory')
		.withIndex('by_companyId_and_creatorId_and_createdAt', (q) =>
			q.eq('companyId', access.companyId).eq('creatorId', access.profile._id)
		)
		.order('desc')
		.first();
	if (!contract) return result('contract');
	if (
		!contract.buyerLinkToken &&
		!(await hasActiveLinkForCreator(ctx, access.companyId, access.profile._id))
	)
		return result('buyer-link', contract.contractId);
	if (access.membership.role === 'rep') return result(null, contract.contractId);
	// The catalog counts both connected and reconnect installations as installed.
	const [connection, state] = await Promise.all([
		installation(ctx, access.companyId),
		lifecycle(ctx, access.companyId)
	]);
	const removal = state?.removalId ? await ctx.db.get('hubspotRemovals', state.removalId) : null;
	if (!connection || (removal && !removal.done)) return result('integrations');
	if (!(await hasInvitedColleagues(ctx, access.company))) return result('team');
	return result(null);
}

export const setupHints = query({
	args: {},
	returns: setupProgress,
	handler: async (ctx) => readSetupProgress(ctx, await requireMembership(ctx))
});

/** One auth pass; advisory workspace reads never become account admission inputs. */
export const homeBootstrap = query({
	args: {},
	returns: v.object({
		viewer: viewerResult,
		home: v.union(homeView, v.null()),
		setup: v.union(
			v.object({ membershipId: v.id('memberships'), progress: setupProgress }),
			v.null()
		)
	}),
	handler: async (ctx) => {
		const account = await viewerAccount(ctx);
		const { profile, membership, company } = account;
		if (!profile || !membership || !company || company.deletion)
			return { viewer: await readViewer(ctx, account), home: null, setup: null };
		const access: CompanyAccess = {
			profile,
			membership,
			company,
			companyId: company._id,
			membershipId: membership._id,
			isOwner: company.ownerProfileId === profile._id
		};
		const [viewer, contracts, progress] = await Promise.all([
			readViewer(ctx, account),
			readDirectory(ctx, company._id, '', { cursor: null, numItems: 24 }),
			readSetupProgress(ctx, access)
		]);
		return {
			viewer,
			home: {
				scope: { profileId: profile._id, membershipId: membership._id, companyId: company._id },
				search: '' as const,
				cursor: null,
				numItems: 24 as const,
				contracts
			},
			setup: { membershipId: membership._id, progress }
		};
	}
});

/** The client requests detection; only current, authenticated database facts can complete setup. */
export const completeSetup = mutation({
	args: { membershipId: v.id('memberships') },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const setup = await readMembershipSetup(ctx, access.membership);
		if (setup.setupCompletedAt !== undefined) return true;
		if ((await readSetupProgress(ctx, access, setup)).nextStep !== null) return false;
		await completeMembershipSetup(ctx, access.membership, setup);
		return true;
	}
});
