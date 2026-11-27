import { ConvexError, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { accessibleContract, requireMembership, type CompanyAccess } from './auth';
import { liveLinkFor, resolveAccess } from './buyerLinks';
import { discussionAccess } from '../lib/discussions/validators';

export type DiscussionContext = {
	root: Doc<'savedContracts'>;
	link: Doc<'buyerLinks'>;
	view: NonNullable<Doc<'buyerLinks'>['currentView']>;
};

export async function buyerDiscussionContext(
	ctx: QueryCtx,
	token: string
): Promise<DiscussionContext> {
	const found = await resolveAccess(ctx, token);
	if (!found) throw new ConvexError('This link is unavailable.');
	return {
		root: found.contract,
		link: found.link,
		view: found.view
	};
}

export async function sellerDiscussionContext(
	ctx: QueryCtx,
	membershipId: Id<'memberships'> | undefined,
	id: Id<'savedContracts'>
): Promise<{ access: CompanyAccess; context: DiscussionContext }> {
	const access = await requireMembership(ctx, membershipId);
	const root = accessibleContract(await ctx.db.get('savedContracts', id), access);
	if (!root) throw new ConvexError('This contract is unavailable.');
	const [cleanup, link] = await Promise.all([
		ctx.db
			.query('contractCleanups')
			.withIndex('by_contractId', (q) => q.eq('contractId', root._id))
			.unique(),
		liveLinkFor(ctx, root._id)
	]);
	if (cleanup || !link || link.companyId !== access.companyId)
		throw new ConvexError('Create a buyer link before commenting.');
	return {
		access,
		context: { root, link, view: link.currentView }
	};
}

/** Resolves either a buyer-link token (public) or an authenticated seller contract context. */
export async function discussionContext(
	ctx: QueryCtx,
	access: Infer<typeof discussionAccess>
): Promise<DiscussionContext> {
	if (access.kind === 'buyer') return buyerDiscussionContext(ctx, access.token);
	return (await sellerDiscussionContext(ctx, undefined, access.id)).context;
}

export function ownsDiscussion(
	context: Pick<DiscussionContext, 'root'>,
	row: { companyId: Doc<'company'>['_id']; contractId: Doc<'savedContracts'>['_id'] }
) {
	return row.companyId === context.root.companyId && row.contractId === context.root._id;
}
