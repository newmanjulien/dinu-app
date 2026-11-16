import { ConvexError, v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { mutation, query } from './_generated/server';
import { seller } from './contractState';
import { reviewSummary, changeKind, changeReview } from '../lib/contract/changes';
import { approvalRequest } from './contractValidators';
import { nativeEmailEntry } from './emailValidators';
import { decideChangeArgs, authorityResult, runAuthority } from './contractAuthority';
import {
	approvalRequestArgs,
	confirmCompletionArgs,
	emailOperationResult
} from './nativeEmailValidators';
import {
	latestFor,
	readRequest,
	requestCoverage,
	runEmailOperation,
	effectiveSnapshotEntry
} from './nativeEmail';
import { snapshotPage } from './emailSelectionChunks';
import { reviewSet, changeReviews } from './reviews';
import { DiscussionIndex } from './discussionIndex';

/** Authorized bounded native review pages, including applied evidence without a live thread. */
export const changes = query({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		kind: v.optional(changeKind),
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(changeReview),
	handler: async (ctx, args) => {
		const { contract, access } = await seller(ctx, args);
		return changeReviews(ctx, contract, access, args.paginationOpts, args.kind);
	}
});

export const overview = query({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts'), context: changeKind },
	returns: v.object({
		summary: reviewSummary,
		request: v.union(approvalRequest, v.null()),
		coveredPendingCount: v.number(),
		unsubmittedPendingCount: v.number()
	}),
	handler: async (ctx, args) => {
		const { contract } = await seller(ctx, args),
			request = await latestFor(ctx, args.id, args.context),
			coverage = await requestCoverage(ctx, contract, args.context, request);
		return {
			summary: await reviewSet(ctx, contract, args.context),
			request: request ? (await readRequest(ctx, request, contract)).view : null,
			coveredPendingCount: coverage.coveredPendingCount,
			unsubmittedPendingCount: coverage.unsubmittedPendingCount
		};
	}
});
/** Delivery-owned immutable entry pages intersected with exact effective current heads. */
export const entries = query({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		context: changeKind,
		requestId: v.string(),
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(nativeEmailEntry.extend({ active: v.boolean() })),
	handler: async (ctx, args) => {
		const { contract } = await seller(ctx, args),
			request = await latestFor(ctx, args.id, args.context);
		if (!request || request.id !== args.requestId)
			throw new ConvexError('This approval request was replaced.');
		const delivery = await ctx.db.get('emailDeliveries', request.deliveryId);
		if (
			!delivery ||
			!('snapshot' in delivery) ||
			delivery.event.kind !== 'approval' ||
			delivery.snapshot.state !== 'complete' ||
			delivery.companyId !== contract.root.companyId ||
			delivery.contractId !== contract.root._id
		)
			throw new ConvexError('This approval request is unavailable.');
		const native = await snapshotPage(ctx, delivery, {
				...args.paginationOpts,
				numItems: Math.max(1, Math.min(2, args.paginationOpts.numItems)),
				maximumRowsRead: Math.min(2, args.paginationOpts.maximumRowsRead ?? 2),
				maximumBytesRead: Math.min(256 * 1024, args.paginationOpts.maximumBytesRead ?? 256 * 1024)
			}),
			index = await DiscussionIndex.open(ctx, contract.root),
			page = [];
		for (const row of native.page)
			for (const entry of row.entries)
				page.push({
					...entry,
					active: await effectiveSnapshotEntry(
						ctx,
						contract,
						index,
						entry,
						'approval',
						request.cutoff
					)
				});
		return { ...native, page };
	}
});
export const request = mutation({
	args: approvalRequestArgs.fields,
	returns: emailOperationResult,
	handler: async (ctx, args) => {
		const { contract, access } = await seller(ctx, args);
		return runEmailOperation(ctx, contract, access, { kind: 'approval-request', args });
	}
});
export const confirmCompletion = mutation({
	args: confirmCompletionArgs.fields,
	returns: emailOperationResult,
	handler: async (ctx, args) => {
		const { contract, access } = await seller(ctx, args);
		return runEmailOperation(ctx, contract, access, { kind: 'review-completion', args });
	}
});
export const decideChange = mutation({
	args: decideChangeArgs.fields,
	returns: authorityResult,
	handler: async (ctx, args) => {
		const { contract, access } = await seller(ctx, args);
		return runAuthority(ctx, access, contract, { kind: 'change-decision', args });
	}
});
