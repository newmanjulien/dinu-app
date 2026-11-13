import { paginationResultValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { itemAudience } from '../lib/playbook/model';
import { MAX_PLAYBOOK_ITEMS } from '../lib/playbook/validation';
import { headStructure } from './playbookItemRevisions';
import type { Id } from './_generated/dataModel';
import { mutation, query, type QueryCtx } from './_generated/server';
import { viewerResult } from './accountViews';
import {
	companyDeletion,
	membershipForProfile,
	readAccount,
	requireMembership,
	type CompanyAccess
} from './auth';
import { installation, lifecycle } from './hubspotInstallation';
import { readDirectory } from './contractDirectory';
import { linkFor } from './buyerCurrent';
import { hasInvitedColleagues } from './invitationDeliverySummary';
import { permissionsForRole, role } from './permissions';
import { contractCard } from './savedContractValidators';
import { resolveSetupBooking, setupCallFor } from './csmSetupState';

async function hasRepInstructions(ctx: QueryCtx, companyId: Id<'company'>) {
	let count = 0;
	for await (const head of ctx.db
		.query('playbookItems')
		.withIndex('by_companyId', (q) => q.eq('companyId', companyId))) {
		if (++count > MAX_PLAYBOOK_ITEMS)
			throw new ConvexError('The playbook list exceeds supported size.');
		if (itemAudience(headStructure(head)) === 'rep') return true;
	}
	return false;
}

export async function readViewer(ctx: QueryCtx) {
	const { identity, profile } = await readAccount(ctx);
	if (!profile) return null;
	const membership = await membershipForProfile(ctx, profile._id);
	const company = membership ? await ctx.db.get('company', membership.companyId) : null;
	const [profileAvatar, companyAvatar, deletion, instruction, setupBooking] = await Promise.all([
		profile.avatarId ? ctx.storage.getUrl(profile.avatarId) : null,
		company?.avatarId ? ctx.storage.getUrl(company.avatarId) : null,
		company ? companyDeletion(ctx, company._id) : null,
		company?.templateSourceId ? hasRepInstructions(ctx, company._id) : false,
		company && membership?.role === 'admin' && !company.templateSourceId
			? resolveSetupBooking(ctx, company)
			: null
	]);
	const isOwner = company?.ownerProfileId === profile._id;
	const role = membership && company ? membership.role : 'rep';
	return {
		helpPreferences: profile.helpPreferences,
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
					setupCall: setupCallFor(setupBooking),
					deletionPending: Boolean(deletion)
				}
			: null,
		permissions: permissionsForRole(membership && company ? role : 'rep', isOwner),
		needsInitialization: profile.email !== identity.email.trim().toLowerCase(),
		templateReady: Boolean(company?.templateSourceId),
		instructionsReady: Boolean(instruction)
	};
}

export const viewer = query({
	args: {},
	returns: viewerResult,
	handler: readViewer
});

/** Minimal presentation hint for startup; never substitutes for requireMembership. */
export const workspaceRole = query({
	args: {},
	returns: v.union(
		v.object({ membershipId: v.id('memberships'), companyId: v.id('company'), role }),
		v.null()
	),
	handler: async (ctx) => {
		const { profile } = await readAccount(ctx);
		if (!profile) return null;
		const membership = await membershipForProfile(ctx, profile._id);
		if (!membership || !(await ctx.db.get('company', membership.companyId))) return null;
		return {
			membershipId: membership._id,
			companyId: membership.companyId,
			role: membership.role
		};
	}
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

const scope = v.object({
	profileId: v.id('profiles'),
	membershipId: v.id('memberships'),
	companyId: v.id('company')
});
export const startupHome = query({
	args: {},
	returns: v.object({
		scope,
		search: v.literal(''),
		cursor: v.null(),
		numItems: v.literal(24),
		contracts: paginationResultValidator(contractCard)
	}),
	handler: async (ctx) => {
		const access = await requireMembership(ctx);
		return {
			scope: {
				profileId: access.profile._id,
				membershipId: access.membershipId,
				companyId: access.companyId
			},
			search: '' as const,
			cursor: null,
			numItems: 24 as const,
			contracts: await readDirectory(ctx, access.companyId, '', { cursor: null, numItems: 24 })
		};
	}
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

/** One authoritative checklist for the workspace prompt and support experience. */
async function readSetupProgress(ctx: QueryCtx, access: CompanyAccess) {
	const result = (
		nextStep: typeof setupStep.type,
		contractId: import('./_generated/dataModel').Id<'savedContracts'> | null = null
	) => ({
		complete: access.membership.setupCompletedAt !== undefined,
		nextStep,
		contractId
	});
	if (access.membership.setupCompletedAt !== undefined) return result(null);
	if (!access.company.templateSourceId) return result('template');
	if (!(await hasRepInstructions(ctx, access.companyId))) return result('instructions');
	const contract = await ctx.db
		.query('contractDirectory')
		.withIndex('by_companyId_and_creatorId_and_createdAt', (q) =>
			q.eq('companyId', access.companyId).eq('creatorId', access.profile._id)
		)
		.order('desc')
		.first();
	if (!contract) return result('contract');
	const buyerLink = await ctx.db
		.query('buyerLinks')
		.withIndex('by_companyId_and_creatorId', (q) =>
			q.eq('companyId', access.companyId).eq('creatorId', access.profile._id)
		)
		.first();
	if (!buyerLink && !(await linkFor(ctx, contract.contractId)))
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
	args: { membershipId: v.id('memberships') },
	returns: v.object({
		complete: v.boolean(),
		nextStep: setupStep,
		contractId: v.union(v.id('savedContracts'), v.null())
	}),
	handler: async (ctx, args) =>
		readSetupProgress(ctx, await requireMembership(ctx, args.membershipId))
});

/** The client requests detection; only current, authenticated database facts can complete setup. */
export const completeSetup = mutation({
	args: { membershipId: v.id('memberships') },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		if (access.membership.setupCompletedAt !== undefined) return true;
		if ((await readSetupProgress(ctx, access)).nextStep !== null) return false;
		await ctx.db.patch('memberships', access.membershipId, { setupCompletedAt: Date.now() });
		return true;
	}
});
