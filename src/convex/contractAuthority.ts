import { reviewOperationInputs } from '../lib/contract/changes';
import { prepareActivity } from './hubspotRecords';
import { documentBytes } from './storageCapacity';
import { ConvexError, v, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { CompanyAccess } from './auth';
import type { Contract } from './contractState';
import { changeSession, changeHead, readChangeRow } from './contractChanges';
import { DiscussionIndex } from './discussionIndex';
import { effectiveBuyerSource } from './buyerSupportEligibility';
import { discussionTransitionHooks } from './discussionTransitions';
import { prepareProposalClaim } from './discussionClaims';
import { discussionTape } from '../lib/discussions/tape';
import { decisionCommand } from '../lib/contract/changes';
import { requireContractWork } from './contractPolicy';
import {
	actionKey,
	operation,
	receipt,
	remember,
	planReceiptWrite,
	receiptSealWork,
	sealReceipt,
	receiptChunkFingerprint,
	actorOf
} from './operationReceipts';
import { admitDiscussionWork, DiscussionPreparationRequired } from './discussionMaps';
import { deferDiscussionOperation, sellerPreparationActor } from './discussionPreparation';
import { normalizeProposal, proposalRoot } from './proposalSource';

export const documentExpectation = v.object({
	documentId: v.id('contractDocuments'),
	documentRevision: v.number()
});
export function requireExpectedDocument(
	contract: Contract,
	expected: Infer<typeof documentExpectation>
) {
	if (
		contract.root.documentId !== expected.documentId ||
		contract.root.documentRevision !== expected.documentRevision
	)
		throw new ConvexError(
			'The contract wording changed. Review the current contract and try again.'
		);
}
export async function requireProposalLink(ctx: QueryCtx, contract: Contract, token: string) {
	const link = await ctx.db
		.query('buyerLinks')
		.withIndex('by_token', (q) => q.eq('token', token))
		.unique();
	if (
		!link?.currentView ||
		link.contractId !== contract.root._id ||
		link.companyId !== contract.root.companyId
	)
		throw new ConvexError('This buyer link is unavailable.');
}

export const authorityResult = v.object({
	status: v.union(v.literal('complete'), v.literal('preparing')),
	operationId: v.string()
});
export type AuthorityResult = Infer<typeof authorityResult>;
const accessArgs = {
	membershipId: v.id('memberships'),
	id: v.id('savedContracts'),
	expectedDocument: documentExpectation
};
export const decideChangeArgs = v.object({ ...accessArgs, ...decisionCommand.fields });
export const supportProposalArgs = v.object({
	...accessArgs,
	token: v.string(),
	threadId: v.id('discussionThreads'),
	rootMessageId: v.id('discussionMessages'),
	expectedRootRevision: v.number(),
	expectedCurrentChangeId: v.union(v.id('contractChanges'), v.null()),
	expectedDecisionId: v.union(v.id('contractChangeDecisions'), v.null()),
	operationId: v.string()
});
export const withdrawProposalArgs = v.object({
	...supportProposalArgs.fields,
	changeId: v.id('contractChanges')
});
export type AuthorityInput =
	| { kind: 'change-decision'; args: Infer<typeof decideChangeArgs> }
	| {
			kind: 'proposal-support';
			args: Infer<typeof supportProposalArgs> | Infer<typeof withdrawProposalArgs>;
	  };

/** Exact source validation is shared by the ordinary command and every pending turn. */
export async function authorityTarget(
	ctx: QueryCtx,
	contract: Contract,
	access: CompanyAccess,
	input: AuthorityInput,
	index: DiscussionIndex
) {
	requireExpectedDocument(contract, input.args.expectedDocument);
	if (input.kind === 'change-decision') {
		if (access.membership.role !== 'admin')
			throw new ConvexError('Only an admin can decide this change.');
		const change = await readChangeRow(ctx, input.args.changeId, contract);
		const head = await changeHead(ctx, contract, change.kind, change.key, index);
		if (
			!head ||
			head.current?._id !== change._id ||
			(head.decision?._id ?? null) !== input.args.expectedDecisionId
		)
			throw new ConvexError('This change was replaced or reviewed. Review its current state.');
		if (
			input.args.action === 'undo' &&
			(change.kind !== 'buyer-proposal' || head.applied?._id !== change._id)
		)
			throw new ConvexError('This buyer proposal is no longer applied.');
		if (input.args.action === 'decline' && head.applied?._id === change._id)
			throw new ConvexError(
				'Remove an applied option through the Playbook, or undo an applied buyer proposal.'
			);
		return { head, change, source: null };
	}
	await requireProposalLink(ctx, contract, input.args.token);
	const source = await proposalRoot(ctx, contract, index, input.args);
	const head = await changeHead(ctx, contract, 'buyer-proposal', source.thread._id, index);
	if (
		(head?.current?._id ?? null) !== input.args.expectedCurrentChangeId ||
		(head?.decision?._id ?? null) !== input.args.expectedDecisionId
	)
		throw new ConvexError('This proposal was replaced or reviewed. Review its current state.');
	if (
		'changeId' in input.args &&
		(!head?.current ||
			head.current._id !== input.args.changeId ||
			head.current._id === head.applied?._id)
	)
		throw new ConvexError('This pending proposal was replaced.');
	return { head, change: head?.current ?? null, source };
}

/** Small native commands remain one mutation. Only pre-write capacity yields admit
 * an original receipt, whose exceptional executor stages the actual result. */
export async function runAuthority(
	ctx: MutationCtx,
	access: CompanyAccess,
	contract: Contract,
	input: AuthorityInput,
	resuming?: Doc<'operationReceipts'>
): Promise<AuthorityResult> {
	operation(input.args.operationId);
	if (
		await ctx.db
			.query('contractCleanups')
			.withIndex('by_contractId', (q) => q.eq('contractId', contract.root._id))
			.unique()
	)
		throw new ConvexError('This contract is unavailable.');
	const key = actionKey(access, input.kind, input.args.operationId),
		inputs = reviewOperationInputs(input);
	const prior = await receipt(ctx, key, inputs);
	if (prior?.state === 'complete') return JSON.parse(prior.result) as AuthorityResult;
	if (prior?.state === 'failed')
		throw new ConvexError(prior.error ?? 'This operation could not complete.');
	if (prior?.state === 'preparing' && !resuming)
		return { status: 'preparing', operationId: input.args.operationId };
	if (resuming && prior?._id !== resuming._id)
		throw new Error('Only the original authority operation can resume.');
	await requireContractWork(ctx, contract);
	const index = await DiscussionIndex.open(ctx, contract.root, () =>
		admitDiscussionWork(ctx, { reads: 1, queries: 1 })
	);
	let claim: Awaited<ReturnType<typeof prepareProposalClaim>> | undefined;
	let activityRow: Omit<Doc<'hubspotEvents'>, '_id' | '_creationTime'> | null = null;
	const discussions = discussionTransitionHooks(ctx, contract, {
		index,
		receipt: resuming,
		hooks: {
			reserve: async () => claim?.work ?? {},
			afterChanges: async () => {
				await claim?.commit();
			}
		}
	});
	const result: AuthorityResult = { status: 'complete', operationId: input.args.operationId };
	try {
		const target = await authorityTarget(ctx, contract, access, input, index);
		const session = await changeSession(ctx, contract);
		if (input.kind === 'change-decision') {
			await session.decide({ ...input.args, operationId: key, access });
			if (
				target.change?.kind === 'buyer-proposal' &&
				target.head?.applied?._id !== target.change._id
			) {
				const thread = await effectiveBuyerSource(ctx, index, target.change);
				if (!thread) throw new ConvexError('This proposal changed. Review its current wording.');
				claim = await prepareProposalClaim(
					ctx,
					index,
					thread,
					input.args.action === 'approve' || input.args.action === 'decline'
						? null
						: await index.interval(thread),
					discussionTape(session.document).length
				);
			}
		} else if ('changeId' in input.args) {
			const source = target.source!,
				interval = await index.interval(source.thread);
			if (!interval) throw new ConvexError('This proposal is unavailable.');
			claim = await prepareProposalClaim(
				ctx,
				index,
				source.thread,
				interval,
				discussionTape(session.document).length
			);
			await session.withdraw('buyer-proposal', input.args.threadId, input.args.changeId);
		} else {
			const source = target.source!;
			const interval = await index.interval(source.thread);
			if (!interval) throw new ConvexError('This proposal is unavailable.');
			claim = await prepareProposalClaim(
				ctx,
				index,
				source.thread,
				interval,
				discussionTape(session.document).length
			);
			if (!(
				target.head?.current?.kind === 'buyer-proposal' &&
				target.head.current.source.rootMessageId === source.root._id &&
				target.head.current.source.rootRevision === source.root.revision &&
				target.head.head.status !== 'rejected'
			)) {
				const normalized = normalizeProposal(
					session.document,
					source.thread,
					source.root,
					contract.root
				);
				await session.stage({
					source: { kind: 'buyer-proposal', value: normalized.source },
					key: source.thread._id,
					operationId: key,
					policy: 'required',
					changes: normalized.changes,
					access
				});
			}
		}
		activityRow = await prepareAuthorityActivity(
			ctx,
			contract,
			access,
			input,
			target,
			key,
			session.plan().heads.length > 0
		);
		await session.commit({
			access,
			operationId: input.args.operationId,
			hooks: discussions.hooks,
			reserveTail: async () => {
				let work: import('./contractChanges').TransitionWork;
				if (!resuming)
					work = planReceiptWrite(access.companyId, key, inputs, JSON.stringify(result), {
						contractId: contract.root._id,
						kind: input.kind
					}).work;
				else {
					const seal = await receiptSealWork(ctx, resuming, inputs, JSON.stringify(result));
					work = {
						documents: seal.writes,
						bytes: seal.bytes,
						queries: seal.reads,
						readDocuments: seal.reads,
						readBytes: seal.readBytes,
						functionsScheduled: 1,
						scheduledFunctionArgsBytes: 1024
					};
				}
				if (activityRow) {
					work.documents = (work.documents ?? 0) + 1;
					work.bytes =
						(work.bytes ?? 0) +
						documentBytes({ ...activityRow, _id: 'x'.repeat(32), _creationTime: 0 });
				}
				return work;
			}
		});
	} catch (error) {
		if (!(error instanceof DiscussionPreparationRequired) || discussions.businessWritesStarted)
			throw error;
		const pending = await discussions.deferredNativePlan(
			receiptChunkFingerprint(JSON.stringify([key, inputs]))
		);
		return deferDiscussionOperation(ctx, {
			contract,
			actor: sellerPreparationActor(access),
			kind: input.kind,
			operationId: input.args.operationId,
			key,
			inputs,
			prior: resuming,
			plan: pending
		});
	}
	if (activityRow) await ctx.db.insert('hubspotEvents', activityRow);
	if (resuming)
		await sealReceipt(ctx, resuming, inputs, { state: 'complete', result: JSON.stringify(result) });
	else
		await remember(ctx, access.companyId, key, inputs, JSON.stringify(result), {
			contractId: contract.root._id,
			kind: input.kind
		});
	return result;
}

/** Root edit/delete calls this before replacing the exact old message. Replies never
 * call it. The caller commits the returned session with its own prepared index hooks. */
export async function withdrawProposalRoot(
	ctx: MutationCtx,
	contract: Contract,
	session: Awaited<ReturnType<typeof changeSession>>,
	threadId: Id<'discussionThreads'>,
	rootMessageId: Id<'discussionMessages'>,
	rootRevision: number
) {
	const value = await session.head('buyer-proposal', threadId),
		current = value.current;
	if (
		!current ||
		current === value.applied ||
		current.row.kind !== 'buyer-proposal' ||
		current.row.source.rootMessageId !== rootMessageId ||
		current.row.source.rootRevision !== rootRevision
	)
		return false;
	await session.withdraw('buyer-proposal', threadId, current.id);
	return true;
}

/** Existing provider activity remains atomically owned by the native command. */
export async function prepareAuthorityActivity(
	ctx: MutationCtx,
	contract: Contract,
	access: CompanyAccess,
	input: AuthorityInput,
	target: Awaited<ReturnType<typeof authorityTarget>>,
	key: string,
	changed: boolean
) {
	if (
		input.kind === 'proposal-support' &&
		('changeId' in input.args || access.membership.role !== 'admin' || !changed)
	)
		return null;
	await admitDiscussionWork(ctx, { reads: 3, queries: 3, readBytes: 3 * 1024 * 1024 });
	const change = target.change;
	const action = input.kind === 'change-decision' ? input.args.action : 'approve';
	const description =
		input.kind === 'proposal-support'
			? target.source!.root.text
			: change?.kind === 'buyer-proposal'
				? change.source.text
				: (change?.source.description ?? '');
	return (
		await prepareActivity(
			ctx,
			contract,
			actorOf(access.profile),
			key,
			action === 'approve' ? 'approved' : 'declined',
			JSON.stringify({
				context:
					input.kind === 'proposal-support' || change?.kind === 'buyer-proposal'
						? 'buyer-link'
						: 'playbook',
				changeId: change?._id,
				action,
				description,
				previousStatus: target.head?.head.status,
				changed
			})
		)
	).row;
}
