import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { activeJob } from './emailDeliveries';
import { admitDiscussionWork } from './discussionMaps';
import { validate } from 'convex-helpers/validators';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { discussionCommand, seenMessages } from '../lib/discussions/validators';
import { authorizePreparedOperation } from './discussionPreparation';
import { receiptPayload } from './operationReceipts';
import { discussionContext } from './discussionContext';
import { fingerprint, type DiscussionActor } from './discussionService';
import { discussionOperationKey, writeDiscussion, markDiscussionSeen } from './discussionCommands';

/** One concrete executor for each admitted discussion kind. The stored real actor,
 * original input/key/link and fresh gates authorize every proof turn and adoption. */
export async function advanceDiscussionOperation(ctx: MutationCtx, row: Doc<'operationReceipts'>) {
	const { actor: original, access } = await authorizePreparedOperation(ctx, row);
	if (
		!row.operationId ||
		!row.contractId ||
		(row.kind !== 'discussion-write' && row.kind !== 'discussion-mark-seen')
	)
		throw new Error('Invalid pending discussion owner.');
	const link =
		original.kind === 'buyer' ? { id: original.linkId, token: original.token } : original.link;
	if (!link) throw new Error('A pending discussion requires its original buyer link.');
	const context = await discussionContext(ctx, { token: link.token });
	if (
		context.root._id !== row.contractId ||
		context.link._id !== link.id ||
		context.root.companyId !== row.companyId
	)
		throw new Error('Pending discussion link ownership changed.');
	const actor: DiscussionActor =
		original.kind === 'seller'
			? {
					key: fingerprint(JSON.stringify([row.contractId, 'account', original.profileId])),
					profileId: original.profileId,
					access: access!,
					preparation: original
				}
			: {
					key: fingerprint(
						JSON.stringify([
							row.contractId,
							'buyer',
							original.browserId,
							original.accountIdentity ?? null
						])
					),
					preparation: original
				};
	if (original.kind === 'buyer' && actor.key !== original.actorKey)
		throw new Error('Pending discussion browser ownership changed.');
	if (discussionOperationKey(actor, row.kind, row.operationId) !== row.key)
		throw new Error('Pending discussion original key changed.');
	const payload = await receiptPayload(ctx, row),
		input: unknown = JSON.parse(payload.inputs);
	const common = { token: v.string(), operationId: v.string() };
	if (row.kind === 'discussion-write') {
		if (
			!validate(v.object({ ...common, command: discussionCommand }), input) ||
			input.token !== link.token ||
			input.operationId !== row.operationId
		)
			throw new Error('Pending discussion original input changed.');
		if (input.command.kind === 'create' && !row.preparation?.sourcePassage) {
			if (!row.preparation) throw new Error('Missing pending passage owner.');
			if (!(await activeJob(ctx, row.preparation.passageJobId))) {
				await admitDiscussionWork(ctx, { reads: 2, queries: 2, writes: 2, bytes: 8192 });
				const resolve = makeFunctionReference<
					'action',
					{ receiptId: Doc<'operationReceipts'>['_id'] },
					null
				>('discussionPassageAction:resolve');
				const passageJobId = await ctx.scheduler.runAfter(0, resolve, { receiptId: row._id });
				await ctx.db.patch('operationReceipts', row._id, {
					preparation: { ...row.preparation, passageJobId }
				});
			}
			return;
		}
		await writeDiscussion(ctx, context, actor, input, row);
	} else {
		if (
			!validate(v.object({ ...common, messages: seenMessages }), input) ||
			input.token !== link.token ||
			input.operationId !== row.operationId
		)
			throw new Error('Pending acknowledgment original input changed.');
		await markDiscussionSeen(ctx, context, actor, input, row);
	}
}
