import { ConvexError, v, type Infer } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { requireMembership, accessibleContract } from './auth';
import { exportRequest, snapshot } from './savedContractValidators';
import schema from './schema';
import { snapshotReader } from './templates';
import { savedReviews } from '../lib/contract/approval';
import { internal } from './_generated/api';

const requiredReview = v.object({
	itemId: v.id('playbookItems'),
	concessionId: v.string(),
	lifecycle: v.string()
});

async function currentContract(ctx: QueryCtx, args: Infer<typeof exportRequest>) {
	const access = await requireMembership(ctx, args.membershipId);
	if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)
		throw new ConvexError('Invalid contract revision.');
	const contract = accessibleContract(await ctx.db.get('savedContracts', args.id), access);
	if (!contract) throw new ConvexError('This contract was deleted.');
	if (contract.revision !== args.expectedRevision)
		throw new ConvexError(
			'This contract changed. Wait for the latest saved version before downloading.'
		);
	return contract;
}

/** Capture authorization, saved choices, approvals and immutable content in one read. */
export const source = internalQuery({
	args: exportRequest.fields,
	returns: v.object({
		contract: schema.doc('savedContracts'),
		snapshot,
		requiredReviews: v.array(requiredReview)
	}),
	handler: async (ctx, args) => {
		const contract = await currentContract(ctx, args);
		const snapshot = await (await snapshotReader(ctx, contract)).read();
		const items = new Map(snapshot.items.map((item) => [item._id, item]));
		for (const [id, concessionId] of Object.entries(contract.selectedConcessions)) {
			const item = items.get(id as (typeof snapshot.items)[number]['_id']);
			if (!item?.concessions.some((concession) => concession.id === concessionId))
				throw new ConvexError('This contract contains an unavailable concession.');
		}
		const reviews = savedReviews(snapshot.items, contract);
		if (reviews.some((review) => review.status !== 'approved'))
			throw new ConvexError('All selected concessions must be approved before downloading.');
		return {
			contract,
			snapshot,
			requiredReviews: reviews.map(({ itemId, concessionId, lifecycle }) => ({
				itemId,
				concessionId,
				lifecycle
			}))
		};
	}
});

/** Authorize delivery and retire the file in the same transaction. Content was validated at capture. */
export const finalize = internalMutation({
	args: exportRequest.extend({
		templateVersionId: v.id('templateVersions'),
		requiredReviews: v.array(requiredReview),
		fileId: v.id('_storage')
	}).fields,
	returns: v.string(),
	handler: async (ctx, args) => {
		const contract = await currentContract(ctx, args);
		const version = await ctx.db.get('templateVersions', args.templateVersionId);
		if (
			contract.templateVersionId !== args.templateVersionId ||
			!version ||
			version.companyId !== contract.companyId
		)
			throw new ConvexError('This template version is unavailable.');
		if (
			args.requiredReviews.some(({ itemId, concessionId, lifecycle }) => {
				const review = contract.reviews[itemId];
				return (
					contract.selectedConcessions[itemId] !== concessionId ||
					review?.concessionId !== concessionId ||
					review.lifecycle !== lifecycle ||
					review.status !== 'approved'
				);
			})
		)
			throw new ConvexError('All selected concessions must be approved before downloading.');
		const url = await ctx.storage.getUrl(args.fileId);
		if (!url) throw new ConvexError('We couldn’t prepare this download. Try again.');
		await ctx.scheduler.runAfter(60 * 60_000, internal.contractExports.removeFile, {
			fileId: args.fileId
		});
		return url;
	}
});

export const removeFile = internalMutation({
	args: { fileId: v.id('_storage') },
	returns: v.null(),
	handler: async (ctx, { fileId }) => {
		await ctx.storage.delete(fileId);
		return null;
	}
});
