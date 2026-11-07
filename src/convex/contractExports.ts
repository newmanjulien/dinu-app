import { ConvexError, v, type Infer } from 'convex/values';
import { concessionSelections } from '../lib/contract/applications';
import { savedReviews } from '../lib/contract/approval';
import { baselineBlock } from '../lib/contract/source-validators';
import { internal } from './_generated/api';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { accessibleContract, requireMembership } from './auth';
import { historicalItem } from './playbookValidators';
import { exportRequest } from './savedContractValidators';
import schema from './schema';
import { snapshotReader } from './templates';
import { installation, requireContractWork } from './contractPolicy';

const requiredReview = v.object({
	itemId: v.id('playbookItems'),
	concessionId: v.string(),
	applicationId: v.string()
});

async function currentContract(ctx: QueryCtx, args: Infer<typeof exportRequest>) {
	const access = await requireMembership(ctx, args.membershipId);
	if (!Number.isSafeInteger(args.expectedEditRevision) || args.expectedEditRevision < 0)
		throw new ConvexError('Invalid contract revision.');
	const contract = accessibleContract(await ctx.db.get('savedContracts', args.id), access);
	if (!contract) throw new ConvexError('This contract was deleted.');
	await requireContractWork(ctx, contract);
	// Old in-flight exports have no captured CRM destination. Never backfill one.
	if (await installation(ctx, contract.companyId))
		throw new ConvexError('Reload before downloading this contract.');
	if (contract.editRevision !== args.expectedEditRevision)
		throw new ConvexError(
			'This contract changed. Wait for the latest saved version before downloading.'
		);
	return contract;
}

/** Capture authorization, saved choices, approvals and immutable content in one read. */
export const capture = internalQuery({
	args: exportRequest.fields,
	returns: v.object({
		contract: schema.doc('savedContracts'),
		blocks: v.array(baselineBlock),
		items: v.array(historicalItem),
		requiredReviews: v.array(requiredReview)
	}),
	handler: async (ctx, args) => {
		const contract = await currentContract(ctx, args);
		const reader = await snapshotReader(ctx, contract);
		const [blocks, items] = await Promise.all([
			reader.blocks(),
			reader.selectedItems(
				concessionSelections(contract.applications),
				'This contract contains an unavailable concession.'
			)
		]);
		const reviews = savedReviews(items, contract);
		if (reviews.some((review) => review.status !== 'approved'))
			throw new ConvexError('All selected concessions must be approved before downloading.');
		return {
			contract,
			blocks,
			items,
			requiredReviews: reviews.map(({ itemId, concessionId, applicationId }) => ({
				itemId,
				concessionId,
				applicationId
			}))
		};
	}
});

/** Authorize delivery and retire the file in the same transaction. Content was validated at capture. */
export const authorizeDownload = internalMutation({
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
			args.requiredReviews.some(({ itemId, concessionId, applicationId }) => {
				const review = contract.applications[itemId]?.approval;
				return (
					contract.applications[itemId]?.concessionId !== concessionId ||
					!review ||
					review.applicationId !== applicationId ||
					review.status !== 'approved'
				);
			})
		)
			throw new ConvexError('All selected concessions must be approved before downloading.');
		const url = await ctx.storage.getUrl(args.fileId);
		if (!url) throw new ConvexError('We couldn’t prepare this download. Try again.');
		await ctx.scheduler.runAfter(60 * 60_000, internal.storageOwnership.discardFile, {
			fileId: args.fileId
		});
		return url;
	}
});

export { finalize, source } from './legacyExports';
