import { ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { assertPermission, type Permission } from './permissions';

export async function verifiedIdentity(ctx: Pick<QueryCtx, 'auth'>) {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity || !identity.email || identity.emailVerified !== true)
		throw new ConvexError('Log in with a verified email address.');
	return { ...identity, email: identity.email };
}
/** Viewer/initialization may observe a missing profile; all paths reject deleted accounts. */
export async function readAccount(
	ctx: QueryCtx,
	knownIdentity?: Awaited<ReturnType<typeof verifiedIdentity>>
) {
	const identity = knownIdentity ?? (await verifiedIdentity(ctx));
	const profile = await ctx.db
		.query('profiles')
		.withIndex('by_identity', (q) => q.eq('identity', identity.tokenIdentifier))
		.unique();
	const deleted =
		!profile &&
		(await ctx.db
			.query('deletedUsers')
			.withIndex('by_issuer_and_clerkId', (q) =>
				q.eq('issuer', identity.issuer).eq('clerkId', identity.subject)
			)
			.unique());
	if (deleted || profile?.deletedAt !== undefined)
		throw new ConvexError({ code: 'account-deleted', message: 'This account has been deleted.' });
	return { identity, profile };
}
export async function requireAccount(ctx: QueryCtx) {
	const { identity, profile } = await readAccount(ctx);
	if (!profile) throw new ConvexError('Your account is still initializing.');
	return { identity, profile };
}
export async function requireProfile(ctx: QueryCtx) {
	return (await requireAccount(ctx)).profile;
}
export function membershipForProfile(ctx: QueryCtx, profileId: Id<'profiles'>) {
	// The indexed unique read participates in the transaction: concurrent joins conflict.
	return ctx.db
		.query('memberships')
		.withIndex('by_profileId', (q) => q.eq('profileId', profileId))
		.unique();
}
/** Optional recognition on public links never initializes an account or a workspace. */
export async function memberForCompany(ctx: QueryCtx, companyId: Id<'company'>) {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) return null;
	if (!identity.email || identity.emailVerified !== true) return null;
	const { profile } = await readAccount(ctx, { ...identity, email: identity.email });
	if (!profile) return null;
	const membership = await membershipForProfile(ctx, profile._id);
	return membership?.companyId === companyId ? { profile, membership } : null;
}
export async function requireMembership(ctx: QueryCtx, expectedMembershipId?: Id<'memberships'>) {
	const [profile, supplied] = await Promise.all([
		requireProfile(ctx),
		expectedMembershipId ? ctx.db.get('memberships', expectedMembershipId) : null
	]);
	const membership = expectedMembershipId ? supplied : await membershipForProfile(ctx, profile._id);
	if (!membership || membership.profileId !== profile._id)
		throw new ConvexError('Your company access has changed. Reload to continue.');
	const company = await requireCompany(ctx, membership.companyId);
	return {
		profile,
		membership,
		company,
		companyId: company._id,
		membershipId: membership._id,
		isOwner: company.ownerProfileId === profile._id
	};
}
export function companyDeletion(ctx: QueryCtx, companyId: Id<'company'>) {
	return ctx.db
		.query('companyDeletions')
		.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
		.unique();
}
export async function availableCompany(ctx: QueryCtx, companyId: Id<'company'>) {
	const company = await ctx.db.get('company', companyId);
	return company?.deletion ? null : company;
}
export async function requireCompany(ctx: QueryCtx, companyId: Id<'company'>) {
	const company = await ctx.db.get('company', companyId);
	if (!company) throw new ConvexError('This company is unavailable.');
	if (company.deletion)
		throw new ConvexError('Company activity is paused while account deletion finishes.');
	return company;
}
export type CompanyAccess = Awaited<ReturnType<typeof requireMembership>>;
export async function requirePermission(
	ctx: QueryCtx,
	permission: Permission,
	membershipId?: Id<'memberships'>
) {
	const access = await requireMembership(ctx, membershipId);
	assertPermission(access.membership.role, permission, access.isOwner);
	return access;
}
export async function liveProfile(ctx: QueryCtx, profileId?: Id<'profiles'>) {
	if (!profileId) return null;
	const profile = await ctx.db.get('profiles', profileId);
	return profile?.deletedAt !== undefined ? null : profile;
}
/** Callers deduplicate profile IDs within their transaction; never cache across requests. */
export async function liveCompanyMember(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	profileId: Id<'profiles'>
) {
	const [profile, membership] = await Promise.all([
		liveProfile(ctx, profileId),
		membershipForProfile(ctx, profileId)
	]);
	return membership?.companyId === companyId ? profile : null;
}
export function accessibleContract(contract: Doc<'savedContracts'> | null, access: CompanyAccess) {
	return contract?.companyId === access.companyId ? contract : null;
}
export function scopedOperation(access: Pick<CompanyAccess, 'membershipId'>, operationId: string) {
	return `${access.membershipId}:${operationId}`;
}
