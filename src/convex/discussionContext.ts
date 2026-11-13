import { ConvexError, type Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { resolveAccess } from './buyerLinks';
import { readContract, type Contract } from './contractState';
import { readContractDocument } from './contractDocuments';
import { discussionAccess } from '../lib/discussions/validators';
import { DiscussionIndex } from './discussionIndex';

export type DiscussionContext = {
	root: Contract['root'];
	contract: Contract;
	link: Doc<'buyerLinks'>;
	index: DiscussionIndex;
};
/** The buyer link is the sole discussion audience, including authenticated sellers.
 * Live link/company/deletion access precedes every content, replay and result read. */
export async function discussionContext(
	ctx: QueryCtx,
	access: Infer<typeof discussionAccess>
): Promise<DiscussionContext> {
	const found = await resolveAccess(ctx, access.token);
	if (!found) throw new ConvexError('This link is unavailable.');
	const deletion = await ctx.db
		.query('contractCleanups')
		.withIndex('by_contractId', (q) => q.eq('contractId', found.contract._id))
		.unique();
	if (deletion) throw new ConvexError('This contract is unavailable.');
	const contract = await readContract(ctx, found.contract);
	return {
		root: contract.root,
		contract,
		link: found.link,
		index: await DiscussionIndex.open(ctx, contract.root)
	};
}
export function ownsDiscussion(
	context: Pick<DiscussionContext, 'root'>,
	row: { companyId: Doc<'company'>['_id']; contractId: Doc<'savedContracts'>['_id'] }
) {
	return row.companyId === context.root.companyId && row.contractId === context.root._id;
}
export async function liveDiscussionThread(
	context: DiscussionContext,
	id: Doc<'discussionThreads'>['_id']
) {
	const thread = await context.index.thread(id);
	return thread && ownsDiscussion(context, thread) && (await context.index.interval(thread))
		? thread
		: null;
}
export async function readDiscussionWording(ctx: QueryCtx, context: DiscussionContext) {
	return {
		document: await readContractDocument(
			ctx,
			context.root.documentId,
			{ companyId: context.root.companyId, contractId: context.root._id },
			{ deferOnCapacity: true }
		),
		revision: context.root.documentRevision,
		contentIdentity: context.root.documentId
	};
}
