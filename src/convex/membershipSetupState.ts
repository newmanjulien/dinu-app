import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

export async function readMembershipSetup(ctx: QueryCtx, membership: Doc<'memberships'>) {
	const row = await ctx.db
		.query('membershipSetupState')
		.withIndex('by_membershipId', (q) => q.eq('membershipId', membership._id))
		.unique();
	return {
		row,
		setupCompletedAt: row?.setupCompletedAt
	};
}

type MembershipSetup = Awaited<ReturnType<typeof readMembershipSetup>>;

export async function completeMembershipSetup(
	ctx: MutationCtx,
	membership: Doc<'memberships'>,
	state: MembershipSetup
) {
	if (state.row) {
		await ctx.db.patch('membershipSetupState', state.row._id, { setupCompletedAt: Date.now() });
	} else {
		await ctx.db.insert('membershipSetupState', {
			membershipId: membership._id,
			setupCompletedAt: Date.now()
		});
	}
}

export async function deleteMembershipSetup(ctx: MutationCtx, membershipId: Id<'memberships'>) {
	const row = await ctx.db
		.query('membershipSetupState')
		.withIndex('by_membershipId', (q) => q.eq('membershipId', membershipId))
		.unique();
	if (row) await ctx.db.delete('membershipSetupState', row._id);
}
