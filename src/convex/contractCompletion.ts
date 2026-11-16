import { ConvexError, v, type Infer } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import { seller } from './contractState';
import { changeKind, reviewGroupKey } from '../lib/contract/changes';
import { reviewSet } from './reviews';

export const completionArgs = v.object({
	membershipId: v.id('memberships'),
	id: v.id('savedContracts'),
	context: changeKind,
	expectedIdentity: v.string(),
	token: v.optional(v.string())
});
/** The delivery owner calls this again at queue adoption and immediately before
 * dispatch. Neither the token nor a retained delivery substitutes for live access.
 * Queue/snapshot creation belongs to the native request/email executor. */
export async function completionContext(ctx: QueryCtx, args: Infer<typeof completionArgs>) {
	const { contract, access } = await seller(ctx, args);
	if (access.membership.role !== 'admin')
		throw new ConvexError('Only company admins can manage reviews.');
	if (
		await ctx.db
			.query('contractCleanups')
			.withIndex('by_contractId', (q) => q.eq('contractId', contract.root._id))
			.unique()
	)
		throw new ConvexError('This contract is unavailable.');
	const summary = await reviewSet(ctx, contract, args.context);
	const completion = contract.root.reviews[reviewGroupKey(args.context)].completion;
	if (
		!summary.complete ||
		summary.identity !== args.expectedIdentity ||
		completion?.reviewIdentity !== summary.identity
	)
		return null;
	if (args.context === 'buyer-link') {
		const link = args.token
			? await ctx.db
					.query('buyerLinks')
					.withIndex('by_token', (q) => q.eq('token', args.token!))
					.unique()
			: null;
		if (
			!link?.currentView ||
			link.contractId !== contract.root._id ||
			link.companyId !== access.companyId
		)
			throw new ConvexError('This buyer link is unavailable.');
	}
	return { contract, access, summary, completion: completion.completion };
}
