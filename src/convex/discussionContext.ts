import { ConvexError, type Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { resolveAccess } from './buyerLinks';
import { discussionAccess } from '../lib/discussions/validators';

export type DiscussionContext = {
	root: Doc<'savedContracts'>;
	link: Doc<'buyerLinks'>;
	view: NonNullable<Doc<'buyerLinks'>['currentView']>;
};

/** The buyer link is the sole discussion audience, including authenticated sellers. */
export async function discussionContext(
	ctx: QueryCtx,
	access: Infer<typeof discussionAccess>
): Promise<DiscussionContext> {
	const found = await resolveAccess(ctx, access.token);
	if (!found) throw new ConvexError('This link is unavailable.');
	return {
		root: found.contract,
		link: found.link,
		view: found.view
	};
}

export function ownsDiscussion(
	context: Pick<DiscussionContext, 'root'>,
	row: { companyId: Doc<'company'>['_id']; contractId: Doc<'savedContracts'>['_id'] }
) {
	return row.companyId === context.root.companyId && row.contractId === context.root._id;
}
