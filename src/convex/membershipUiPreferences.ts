import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

export function preferenceForMembership(
	ctx: QueryCtx | MutationCtx,
	membershipId: Id<'memberships'>
) {
	return ctx.db
		.query('membershipUiPreferences')
		.withIndex('by_membershipId', (q) => q.eq('membershipId', membershipId))
		.unique();
}

export async function supportWidgetCollapsed(ctx: QueryCtx, membership: Doc<'memberships'>) {
	const preference = await preferenceForMembership(ctx, membership._id);
	return preference?.supportWidgetCollapsed ?? false;
}

export async function deleteMembershipUiPreferences(
	ctx: MutationCtx,
	membershipId: Id<'memberships'>
) {
	const preference = await preferenceForMembership(ctx, membershipId);
	if (preference) await ctx.db.delete('membershipUiPreferences', preference._id);
}
