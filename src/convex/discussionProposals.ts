import { v } from 'convex/values';
import { changeStatus } from '../lib/contract/changes';
import { DiscussionIndex } from './discussionIndex';
import { changeHead } from './contractChanges';
import { proposalRoot } from './proposalSource';
import { mutation, query } from './_generated/server';
import { seller } from './contractState';
import {
	supportProposalArgs,
	withdrawProposalArgs,
	authorityResult,
	requireExpectedDocument,
	requireProposalLink,
	runAuthority
} from './contractAuthority';

export const support = mutation({
	args: supportProposalArgs.fields,
	returns: authorityResult,
	handler: async (ctx, args) => {
		const { contract, access } = await seller(ctx, args);
		return runAuthority(ctx, access, contract, { kind: 'proposal-support', args });
	}
});
export const withdraw = mutation({
	args: withdrawProposalArgs.fields,
	returns: authorityResult,
	handler: async (ctx, args) => {
		const { contract, access } = await seller(ctx, args);
		return runAuthority(ctx, access, contract, { kind: 'proposal-support', args });
	}
});

/** A visible proposal action reads one exact effective tuple, independent of list paging. */
export const supportState = query({
	args: supportProposalArgs
		.pick(
			'membershipId',
			'id',
			'expectedDocument',
			'threadId',
			'rootMessageId',
			'expectedRootRevision'
		)
		.extend({ token: v.string() }).fields,
	returns: v.object({
		currentChangeId: v.union(v.id('contractChanges'), v.null()),
		appliedChangeId: v.union(v.id('contractChanges'), v.null()),
		decisionId: v.union(v.id('contractChangeDecisions'), v.null()),
		status: changeStatus,
		currentRootMessageId: v.union(v.id('discussionMessages'), v.null()),
		currentRootRevision: v.union(v.number(), v.null())
	}),
	handler: async (ctx, args) => {
		const { contract } = await seller(ctx, args);
		await requireProposalLink(ctx, contract, args.token);
		requireExpectedDocument(contract, args.expectedDocument);
		const index = await DiscussionIndex.open(ctx, contract.root);
		await proposalRoot(ctx, contract, index, args);
		const state = await changeHead(ctx, contract, 'buyer-proposal', args.threadId, index);
		return {
			currentChangeId: state?.current?._id ?? null,
			appliedChangeId: state?.applied?._id ?? null,
			decisionId: state?.decision?._id ?? null,
			status: state?.head.status ?? 'approved',
			currentRootMessageId:
				state?.current?.kind === 'buyer-proposal' ? state.current.source.rootMessageId : null,
			currentRootRevision:
				state?.current?.kind === 'buyer-proposal' ? state.current.source.rootRevision : null
		};
	}
});
