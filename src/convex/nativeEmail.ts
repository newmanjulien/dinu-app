import { expireOperation } from './operationExpiry';
import { reviewOperationInputs, reviewGroupKey } from '../lib/contract/changes';
import { ConvexError, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { CompanyAccess } from './auth';
import type { Contract } from './contractState';
import type { ChangeKind } from '../lib/contract/changes';
import { MAX_SELECTED_CONCESSIONS } from '../lib/document/selection-limits';
import { changeHead, hydrateHead } from './contractChanges';
import { requireExpectedDocument } from './contractAuthority';
import { reviewSet } from './reviews';
import { DiscussionIndex } from './discussionIndex';
import { admitDiscussionWork, DiscussionPreparationRequired } from './discussionMaps';
import { scheduleDiscussionMaintenance } from './discussionMaintenance';
import { authorizePreparedOperation, sellerPreparationActor } from './discussionPreparation';
import {
	actorOf,
	actionKey,
	admitOperation,
	receipt,
	remember,
	receiptPayload,
	planReceiptWrite,
	receiptSealWork,
	sealReceipt
} from './operationReceipts';
import { emailAddress, type NativeEmailEntry, type emailSnapshot } from './emailValidators';
import { planSnapshotChunks, writeSnapshotChunks, snapshotSeed } from './emailSelectionChunks';
import {
	approvalRequestArgs,
	confirmCompletionArgs,
	emailOperationResult
} from './nativeEmailValidators';
import { approvalRequest } from './contractValidators';
import { completionContext } from './contractCompletion';
import { assertChangeHead, pendingAdmissionRevision } from './contractChangeHeads';
import { requireContractWork } from './contractPolicy';
import { prepareActivity } from './hubspotRecords';
import { documentBytes } from './storageCapacity';
import {
	activeJob,
	restartDelivery,
	UNCERTAIN_COOLDOWN,
	activateSnapshotDelivery
} from './emailDeliveries';
import { retireSnapshotDelivery } from './emailDisposal';

type Snapshot = Infer<typeof emailSnapshot>;
type Result = Infer<typeof emailOperationResult>;
export type EmailInput =
	| { kind: 'approval-request'; args: Infer<typeof approvalRequestArgs> }
	| { kind: 'review-completion'; args: Infer<typeof confirmCompletionArgs> };
export type ReviewDelivery = Extract<Doc<'emailDeliveries'>, { contractId: Id<'savedContracts'> }>;
const fakeId = <T extends 'emailDeliveries' | 'operationReceipts' | 'approvalRequests'>(_: T) =>
	'x'.repeat(32) as Id<T>;

export async function latestFor(
	ctx: QueryCtx,
	contractId: Id<'savedContracts'>,
	context: ChangeKind
) {
	return ctx.db
		.query('approvalRequests')
		.withIndex('by_contractId_and_context', (q) =>
			q.eq('contractId', contractId).eq('context', context)
		)
		.unique();
}
export async function requestCoverage(
	ctx: QueryCtx,
	contract: Contract,
	context: ChangeKind,
	request: Doc<'approvalRequests'> | null,
	index?: DiscussionIndex
) {
	if (context === 'buyer-link') {
		const summary = (index ?? (await DiscussionIndex.open(ctx, contract.root))).supportSummary;
		const matches =
			request && summary.request?.id === request._id && summary.request.cutoff === request.cutoff;
		if (request && !matches) throw new Error('Latest buyer request lost its aggregate ownership.');
		return {
			pendingCount: summary.pendingCount,
			coveredPendingCount: matches ? summary.coveredPendingCount : 0,
			unsubmittedPendingCount: matches ? summary.unsubmittedPendingCount : summary.pendingCount
		};
	}
	if (!request)
		return {
			pendingCount: contract.root.playbookPendingCount,
			coveredPendingCount: 0,
			unsubmittedPendingCount: contract.root.playbookPendingCount
		};
	// This envelope is the existing bounded Playbook selection domain, never buyer proposals.
	const heads = await ctx.db
		.query('contractChangeHeads')
		.withIndex('by_contractId_and_kind_and_activePlaybook', (q) =>
			q.eq('contractId', contract.root._id).eq('kind', 'playbook').eq('activePlaybook', true)
		)
		.take(MAX_SELECTED_CONCESSIONS + 1);
	if (heads.length > MAX_SELECTED_CONCESSIONS)
		throw new Error('Playbook selection envelope failed.');
	let pendingCount = 0,
		coveredPendingCount = 0;
	for (const head of heads) {
		if (head.companyId !== contract.root.companyId)
			throw new Error('Playbook head ownership failed.');
		assertChangeHead(head);
		if (head.kind !== 'playbook') throw new Error('Playbook selection has a different kind.');
		if (head.current?.policy !== 'required' || head.current.review.kind !== 'pending') continue;
		const admission = pendingAdmissionRevision(head.current);
		if (admission === null || admission > contract.root.stateRevision)
			throw new Error('Pending Playbook admission is missing or invalid.');
		pendingCount++;
		if (admission <= request.cutoff) coveredPendingCount++;
	}
	if (pendingCount !== contract.root.playbookPendingCount)
		throw new Error('Playbook pending summary differs.');
	return {
		pendingCount,
		coveredPendingCount,
		unsubmittedPendingCount: pendingCount - coveredPendingCount
	};
}
export async function readRequest(
	ctx: QueryCtx,
	request: Doc<'approvalRequests'>,
	contract: Contract,
	index?: DiscussionIndex
) {
	const delivery = await ctx.db.get('emailDeliveries', request.deliveryId);
	if (
		delivery &&
		(!('snapshot' in delivery) ||
			delivery.event.kind !== 'approval' ||
			delivery.contractId !== request.contractId ||
			delivery.companyId !== request.companyId ||
			delivery.event.requestId !== request.id ||
			delivery.snapshot.state !== 'complete')
	)
		throw new Error('Approval delivery ownership is invalid.');
	const coverage = await requestCoverage(ctx, contract, request.context, request, index),
		state = delivery?.state;
	const status = !state || state.kind === 'skipped' ? 'failed' : state.kind;
	const view: Infer<typeof approvalRequest> = {
		id: request.id,
		context: request.context,
		identity: request.identity,
		cutoff: request.cutoff,
		title: request.title,
		count: request.count,
		coveredPendingCount: coverage.coveredPendingCount,
		unsubmittedPendingCount: coverage.unsubmittedPendingCount,
		active: coverage.coveredPendingCount > 0,
		requestedAt: request.requestedAt,
		status,
		completedAt: state?.kind !== 'sending' ? state?.completedAt : undefined,
		error: state?.kind !== 'sending' ? state?.error : undefined,
		retryAt: state?.kind === 'uncertain' ? state.completedAt + UNCERTAIN_COOLDOWN : undefined,
		retryEligible: Boolean(
			delivery?.execution.kind === 'scheduled' &&
			(status === 'failed' || (state?.kind === 'uncertain' && state.retryEligible)) &&
			!delivery.disposal &&
			!(await activeJob(ctx, delivery.execution.sendJobId))
		)
	};
	return { view, delivery };
}

export async function ownedReviewLink(
	ctx: QueryCtx,
	contract: Contract,
	context: ChangeKind,
	token?: string
) {
	if (context !== 'buyer-link') return null;
	const link = token
		? await ctx.db
				.query('buyerLinks')
				.withIndex('by_token', (q) => q.eq('token', token))
				.unique()
		: null;
	if (
		!link?.currentView ||
		link.companyId !== contract.root.companyId ||
		link.contractId !== contract.root._id
	)
		throw new ConvexError('This buyer link is unavailable.');
	return link;
}
export async function nativeReviewPage(
	ctx: QueryCtx,
	contract: Contract,
	context: ChangeKind,
	purpose: 'approval' | 'decision',
	cursor: string | null,
	index: DiscussionIndex
) {
	const result = await ctx.db
		.query('contractChangeHeads')
		.withIndex('by_contractId_and_kind', (q) =>
			q.eq('contractId', contract.root._id).eq('kind', context)
		)
		.paginate({ cursor, numItems: 4, maximumRowsRead: 4, maximumBytesRead: 256 * 1024 });
	const entries: NativeEmailEntry[] = [];
	for (const row of result.page) {
		const item = await hydrateHead(ctx, contract, row, index),
			current = item.current;
		if (
			!current ||
			current.policy !== 'required' ||
			(purpose === 'approval' ? item.head.status !== 'pending' : item.head.status === 'pending')
		)
			continue;
		const admission =
			item.head.status === 'pending' ? pendingAdmissionRevision(item.head.current) : null;
		if (
			(item.head.status === 'pending' && admission === null) ||
			(admission !== null && admission > contract.root.stateRevision)
		)
			throw new Error('Pending native admission is invalid.');
		entries.push({
			changeId: current._id,
			decisionId: item.decision?._id ?? null,
			key: current.key,
			status: item.head.status,
			pendingAdmissionRevision: admission,
			actor: current.actor,
			source:
				current.kind === 'playbook'
					? { kind: 'playbook', value: current.source }
					: { kind: 'buyer-link', value: current.source },
			decision: item.decision
				? { actor: item.decision.actor, decidedAt: item.decision.decidedAt }
				: null
		});
	}
	return { ...result, entries };
}
/** Exact current tuple + renewed admission + source-effective hydration, never whole-token equality. */
export async function effectiveSnapshotEntry(
	ctx: QueryCtx,
	contract: Contract,
	index: DiscussionIndex,
	entry: NativeEmailEntry,
	purpose: 'approval' | 'decision',
	cutoff: number
) {
	const item = await changeHead(ctx, contract, entry.source.kind, entry.key, index);
	return Boolean(
		item?.current?._id === entry.changeId &&
		item.current.policy === 'required' &&
		(item.decision?._id ?? null) === entry.decisionId &&
		item.head.status === entry.status &&
		(purpose === 'decision'
			? entry.status !== 'pending'
			: entry.status === 'pending' &&
				entry.pendingAdmissionRevision !== null &&
				entry.pendingAdmissionRevision <= cutoff &&
				pendingAdmissionRevision(item.head.current) === entry.pendingAdmissionRevision)
	);
}
export async function authorizeReviewDelivery(ctx: QueryCtx, delivery: ReviewDelivery) {
	const snapshot = delivery.snapshot;
	if (snapshot.state !== 'complete' || delivery.disposal) return null;
	const authorized = await authorizePreparedOperation(ctx, {
		companyId: delivery.companyId,
		contractId: delivery.contractId,
		actor: snapshot.actor,
		operationId: snapshot.operationId
	});
	if (
		!authorized.access ||
		actionKey(
			authorized.access,
			delivery.event.kind === 'approval' ? 'approval-request' : 'review-completion',
			snapshot.operationId
		) !== snapshot.ownerKey
	)
		throw new Error('Delivery actor/key is invalid.');
	const { contract, access } = authorized;
	if (contract.root.templateVersionId !== delivery.event.templateVersionId) return null;
	await ownedReviewLink(ctx, contract, delivery.event.context, delivery.event.buyerToken);
	const index = await DiscussionIndex.open(ctx, contract.root);
	if (delivery.event.kind === 'decision') {
		if (access.membership.role !== 'admin') return null;
		const summary = await reviewSet(ctx, contract, delivery.event.context),
			completion = contract.root.reviews[reviewGroupKey(delivery.event.context)].completion;
		if (
			!summary.complete ||
			summary.identity !== delivery.event.identity ||
			completion?.reviewIdentity !== summary.identity ||
			completion.completion.kind !== 'queued' ||
			completion.completion.deliveryId !== delivery._id
		)
			return null;
	} else {
		const latest = await latestFor(ctx, contract.root._id, delivery.event.context);
		if (!latest || latest.id !== delivery.event.requestId || latest.deliveryId !== delivery._id)
			return null;
		if (
			!(await requestCoverage(ctx, contract, delivery.event.context, latest, index))
				.coveredPendingCount
		)
			return null;
	}
	return { contract, access, index };
}

const resultFor = (input: EmailInput, extra: Partial<Result> = {}): Result => ({
	status: 'complete',
	operationId: input.args.operationId,
	...extra
});
const completionPatch = (
	contract: Contract,
	context: ChangeKind,
	value: Doc<'savedContracts'>['reviews']['playbook']['completion']
) => ({
	reviews: {
		...contract.root.reviews,
		[reviewGroupKey(context)]: { ...contract.root.reviews[reviewGroupKey(context)], completion: value }
	}
});

async function reserve(ctx: MutationCtx, writes: number, bytes: number, scheduled = 0, extra = {}) {
	await admitDiscussionWork(ctx, { writes, bytes, ...extra });
	const metrics = await ctx.meta.getTransactionMetrics();
	if (
		metrics.functionsScheduled.remaining < scheduled + 1 ||
		metrics.scheduledFunctionArgsBytes.remaining < scheduled * 1024 + 1024
	)
		throw new DiscussionPreparationRequired('capacity');
}
function requestRow(contract: Contract, delivery: ReviewDelivery) {
	if (delivery.event.kind !== 'approval') throw new Error('Approval event required.');
	return {
		companyId: contract.root.companyId,
		contractId: contract.root._id,
		context: delivery.event.context,
		identity: delivery.event.identity,
		cutoff: delivery.snapshot.cutoff,
		count: delivery.snapshot.count,
		id: delivery.event.requestId,
		title: delivery.event.title,
		recipientEmail: delivery.event.recipientEmail,
		requestedAt: delivery._creationTime,
		deliveryId: delivery._id
	};
}
async function finishSnapshot(
	ctx: MutationCtx,
	contract: Contract,
	access: CompanyAccess,
	input: EmailInput,
	delivery: ReviewDelivery,
	progress: { order: number; count: number; bytes: number; hash: string },
	index: DiscussionIndex,
	original?: Doc<'operationReceipts'>,
	chunks?: ReturnType<typeof planSnapshotChunks>
) {
	const snapshot = delivery.snapshot;
	if (progress.count !== snapshot.count)
		throw new Error('Native snapshot count differs from the exact summary.');
	const latest = await latestFor(ctx, contract.root._id, input.args.context);
	if ((latest?.id ?? null) !== snapshot.latestRequestId)
		throw new ConvexError('The approval request changed. Reload before submitting.');
	if (input.kind === 'review-completion') {
		const current = contract.root.reviews[reviewGroupKey(input.args.context)].completion;
		if (
			access.membership.role !== 'admin' ||
			current?.reviewIdentity !== input.args.expectedIdentity ||
			current.completion.kind !== 'awaitingConfirmation'
		)
			throw new ConvexError('The review completion changed.');
	}
	const row = delivery.event.kind === 'approval' ? requestRow(contract, delivery) : null;
	const nextId = latest?._id ?? fakeId('approvalRequests');
	if (row && input.args.context === 'buyer-link') index.activateRequest(nextId, snapshot.cutoff);
	const control =
		row && input.args.context === 'buyer-link'
			? await index.prepareFlush(index.control?.witnessThreadId ?? null)
			: { documents: 0, bytes: 0 };
	const view: Infer<typeof approvalRequest> | undefined = row
		? {
				id: row.id,
				context: row.context,
				identity: row.identity,
				cutoff: row.cutoff,
				title: row.title,
				count: row.count,
				coveredPendingCount: row.count,
				unsubmittedPendingCount: 0,
				active: true,
				requestedAt: row.requestedAt,
				status: 'sending',
				retryEligible: false
			}
		: undefined;
	const result = resultFor(input, view ? { request: view } : { outcome: 'queued' });
	const encoded = JSON.stringify(result),
		receiptWork = original
			? await receiptSealWork(ctx, original, reviewOperationInputs(input), encoded)
			: (() => {
					const work = planReceiptWrite(
						access.companyId,
						snapshot.ownerKey,
						reviewOperationInputs(input),
						encoded,
						{ contractId: contract.root._id, kind: input.kind }
					).work;
					return { writes: work.documents, bytes: work.bytes, reads: 0, readBytes: 0 };
				})();
	const activity = row
		? (
				await prepareActivity(
					ctx,
					contract,
					actorOf(access.profile),
					snapshot.ownerKey,
					'requested',
					JSON.stringify({ requestId: row.id, count: row.count }),
					row.requestedAt
				)
			).row
		: null;
	const complete = {
		...snapshot,
		receiptId: undefined,
		state: 'complete' as const,
		chunks: progress.order,
		bytes: progress.bytes,
		hash: progress.hash
	};
	let finalDelivery = { ...delivery, snapshot: complete };
	// Includes both scheduling patches, request/control or root completion, exact receipt seal,
	// optional activity, and bounded disposal scheduling. No admission follows a business write.
	await reserve(
		ctx,
		(chunks?.work.writes ?? 0) +
			control.documents +
			receiptWork.writes +
			5 +
			(activity ? 1 : 0) +
			(latest ? 1 : 0),
		(chunks?.work.bytes ?? 0) +
			control.bytes +
			receiptWork.bytes +
			documentBytes(finalDelivery) * 2 +
			(row
				? documentBytes({ ...row, _id: nextId, _creationTime: 0 })
				: documentBytes(contract.root) + 1024) +
			(activity ? documentBytes({ ...activity, _id: 'x'.repeat(32), _creationTime: 0 }) : 0) +
			48 * 1024,
		latest ? 3 : 2,
		{ reads: receiptWork.reads + 8, queries: 8, readBytes: receiptWork.readBytes + 64 * 1024 }
	);
	if (!original) {
		const { _id: _placeholderId, _creationTime: _placeholderTime, ...value } = delivery;
		const id = await ctx.db.insert('emailDeliveries', value);
		finalDelivery = { ...finalDelivery, _id: id };
		if (row) row.deliveryId = id;
		if (chunks)
			chunks = { ...chunks, rows: chunks.rows.map((chunk) => ({ ...chunk, deliveryId: id })) };
	}
	if (chunks) await writeSnapshotChunks(ctx, chunks);
	if (row) {
		const id = latest
			? (await ctx.db.replace('approvalRequests', latest._id, row), latest._id)
			: await ctx.db.insert('approvalRequests', row);
		if (input.args.context === 'buyer-link') {
			index.bindActivatedRequest(id, snapshot.cutoff);
			await index.flush(ctx, index.control?.witnessThreadId ?? null, undefined, false);
		}
	} else
		await ctx.db.patch(
			'savedContracts',
			contract.root._id,
			completionPatch(contract, input.args.context, {
				reviewIdentity: input.args.expectedIdentity,
				completion: { kind: 'queued', deliveryId: finalDelivery._id }
			})
		);
	await activateSnapshotDelivery(ctx, finalDelivery);
	if (activity) await ctx.db.insert('hubspotEvents', activity);
	if (row && latest && latest.deliveryId !== finalDelivery._id) {
		const old = await ctx.db.get('emailDeliveries', latest.deliveryId);
		if (old) await retireSnapshotDelivery(ctx, old);
	}
	if (original)
		await sealReceipt(ctx, original, reviewOperationInputs(input), {
			state: 'complete',
			result: encoded
		});
	else
		await remember(
			ctx,
			access.companyId,
			snapshot.ownerKey,
			reviewOperationInputs(input),
			encoded,
			{
				contractId: contract.root._id,
				kind: input.kind
			}
		);
	return result;
}

export async function runEmailOperation(
	ctx: MutationCtx,
	contract: Contract,
	access: CompanyAccess,
	input: EmailInput
): Promise<Result> {
	admitOperation(input.args.operationId);
	if (input.kind === 'review-completion' && access.membership.role !== 'admin')
		throw new ConvexError('Only company admins can manage reviews.');
	if (
		await ctx.db
			.query('contractCleanups')
			.withIndex('by_contractId', (q) => q.eq('contractId', contract.root._id))
			.unique()
	)
		throw new ConvexError('This contract is unavailable.');
	const key = actionKey(access, input.kind, input.args.operationId),
		inputs = reviewOperationInputs(input),
		prior = await receipt(ctx, key, inputs);
	if (prior?.state === 'complete') return JSON.parse(prior.result) as Result;
	if (prior?.state === 'failed')
		throw new ConvexError(prior.error ?? 'This operation could not complete.');
	if (prior) return { status: 'preparing', operationId: input.args.operationId };
	await requireContractWork(ctx, contract);
	let index = await DiscussionIndex.open(ctx, contract.root);
	const summary = await reviewSet(ctx, contract, input.args.context),
		latest = await latestFor(ctx, contract.root._id, input.args.context),
		link = await ownedReviewLink(ctx, contract, input.args.context, input.args.token);
	const finish = async (result: Result, patch?: ReturnType<typeof completionPatch>) => {
		const planned = planReceiptWrite(access.companyId, key, inputs, JSON.stringify(result), {
			contractId: contract.root._id,
			kind: input.kind
		});
		await reserve(
			ctx,
			planned.work.documents + (patch ? 1 : 0),
			planned.work.bytes + (patch ? documentBytes(contract.root) + 1024 : 0)
		);
		if (patch) await ctx.db.patch('savedContracts', contract.root._id, patch);
		await remember(ctx, access.companyId, key, inputs, JSON.stringify(result), {
			contractId: contract.root._id,
			kind: input.kind
		});
		return result;
	};
	let reviewerId = access.profile._id;
	if (input.kind === 'review-completion') {
		const completion = await completionContext(ctx, input.args);
		if (!completion) return finish(resultFor(input, { outcome: 'stale' }));
		if (completion.completion.kind === 'queued')
			return finish(resultFor(input, { outcome: 'queued' }));
		reviewerId = completion.completion.reviewerId;
		if (!input.args.notify)
			return finish(
				resultFor(input, { outcome: 'dismissed' }),
				completionPatch(contract, input.args.context, undefined)
			);
	} else {
		requireExpectedDocument(contract, input.args.expectedDocument);
		if (summary.identity !== input.args.expectedIdentity)
			throw new ConvexError('The review changed. Review it before submitting.');
		if (!summary.pendingCount) throw new ConvexError('There are no changes waiting for approval.');
		if (!contract.root.title.trim()) throw new ConvexError('Enter a buyer company name.');
		if (latest) {
			const previous = await readRequest(ctx, latest, contract, index),
				view = previous.view;
			if (
				view.status === 'sending' ||
				((view.status === 'failed' || view.status === 'uncertain') && !view.retryEligible)
			)
				throw new ConvexError(
					'The current approval request is still resolving. Please wait before trying again.'
				);
			const configured = access.company.approvalEmail
				? emailAddress(access.company.approvalEmail)
				: null;
			if (
				configured === latest.recipientEmail &&
				view.coveredPendingCount === summary.pendingCount
			) {
				if (view.status === 'sent') return finish(resultFor(input, { request: view }));
				if (previous.delivery) {
					// Reserve the retry jobs, delivery patch, and exact receipt before restarting.
					const result = resultFor(input, {
						request: {
							...view,
							status: 'sending',
							completedAt: undefined,
							error: undefined,
							retryAt: undefined,
							retryEligible: false
						}
					});
					const planned = planReceiptWrite(access.companyId, key, inputs, JSON.stringify(result), {
						contractId: contract.root._id,
						kind: input.kind
					});
					await reserve(
						ctx,
						planned.work.documents + 2,
						planned.work.bytes + documentBytes(previous.delivery) + 4096,
						2
					);
					if (await restartDelivery(ctx, previous.delivery)) {
						await remember(ctx, access.companyId, key, inputs, JSON.stringify(result), {
							contractId: contract.root._id,
							kind: input.kind
						});
						return result;
					}
				}
			}
		}
	}
	const purpose = input.kind === 'approval-request' ? ('approval' as const) : ('decision' as const),
		count = purpose === 'approval' ? summary.pendingCount : summary.count,
		actor = sellerPreparationActor(access);
	if (actor.kind !== 'seller') throw new Error('Review email requires a seller actor.');
	if (link) actor.link = { id: link._id, token: link.token };
	const snapshot: Snapshot = {
		state: 'staging',
		actor,
		operationId: input.args.operationId,
		ownerKey: key,
		generation: 0,
		contextIdentity: summary.identity,
		cutoff: contract.root.stateRevision,
		sourceDocumentId: contract.root.documentId,
		documentRevision: contract.root.documentRevision,
		stateRevision: contract.root.stateRevision,
		supportGeneration: index.supportIndexGeneration,
		storageGeneration: index.nativeStorageGeneration,
		latestRequestId: latest?.id ?? null,
		count,
		chunks: 0,
		bytes: 0,
		hash: snapshotSeed(key, 0)
	};
	const baseEvent = {
		context: input.args.context,
		identity: summary.identity,
		buyerToken: input.args.token,
		contractId: contract.root._id,
		title: contract.root.title,
		templateVersionId: contract.root.templateVersionId
	};
	const configured = access.company.approvalEmail;
	if (purpose === 'approval' && !configured)
		throw new ConvexError('Ask your company admin to configure an approval email in Settings.');
	const event =
		purpose === 'approval'
			? {
					...baseEvent,
					kind: 'approval' as const,
					requestId: key,
					recipientEmail: emailAddress(configured!)
				}
			: { ...baseEvent, kind: 'decision' as const, reviewerId };
	const value = {
		companyId: access.companyId,
		contractId: contract.root._id,
		event,
		snapshot,
		attempt: 1,
		state: { kind: 'sending' as const, dispatch: { kind: 'pending' as const } },
		execution: { kind: 'scheduled' as const }
	};
	// One bounded native page is the common one-mutation path. Larger contexts
	// stage on the same original operation, without a snapshot-size admission cap.
	let small: Awaited<ReturnType<typeof nativeReviewPage>> | null = null;
	try {
		await admitDiscussionWork(ctx, { reads: 320, queries: 320, readBytes: 12 * 1024 * 1024 });
		small = await nativeReviewPage(ctx, contract, input.args.context, purpose, null, index);
	} catch (error) {
		if (!(error instanceof DiscussionPreparationRequired)) throw error;
	}
	if (small?.isDone) {
		if (small.entries.length !== count)
			throw new Error('Exact review summary differs from its snapshot.');
		const placeholder = {
				...value,
				_id: fakeId('emailDeliveries'),
				_creationTime: Date.now()
			} as ReviewDelivery,
			planned = planSnapshotChunks(access.companyId, placeholder._id, 0, small.entries, {
				order: 0,
				hash: snapshot.hash
			});
		try {
			return await finishSnapshot(
				ctx,
				contract,
				access,
				input,
				placeholder,
				{ order: planned.rows.length, count, bytes: planned.bytes, hash: planned.hash },
				index,
				undefined,
				planned
			);
		} catch (error) {
			if (!(error instanceof DiscussionPreparationRequired)) throw error;
			// A pre-write reserve may have prepared activation in memory. Reopen the
			// persisted index before admitting the private original-receipt stage.
			index = await DiscussionIndex.open(ctx, contract.root);
		}
	}
	const progress = {
		deliveryId: fakeId('emailDeliveries'),
		generation: 0,
		unit: 0,
		dueAt: Date.now(),
		cursor: null,
		done: false,
		order: 0,
		count: 0,
		bytes: 0,
		hash: snapshot.hash
	};
	const pending = { actor, operationId: input.args.operationId, emailPreparation: progress };
	const receiptPlan = planReceiptWrite(
		access.companyId,
		key,
		inputs,
		'',
		{ contractId: contract.root._id, kind: input.kind, requestedAt: Date.now() },
		pending
	);
	const control = await index.prepareFlush(index.control?.witnessThreadId ?? null, true);
	await reserve(
		ctx,
		receiptPlan.work.documents + control.documents + 3,
		receiptPlan.work.bytes +
			control.bytes +
			documentBytes({
				...value,
				snapshot: { ...snapshot, receiptId: fakeId('operationReceipts') },
				_id: fakeId('emailDeliveries'),
				_creationTime: 0
			}) *
				2 +
			32 * 1024,
		1
	);
	const id = await ctx.db.insert('emailDeliveries', value);
	const receiptId = await remember(
		ctx,
		access.companyId,
		key,
		inputs,
		'',
		{ contractId: contract.root._id, kind: input.kind, requestedAt: Date.now() },
		{ ...pending, emailPreparation: { ...progress, deliveryId: id } }
	);
	await ctx.db.patch('emailDeliveries', id, { snapshot: { ...snapshot, receiptId } });
	const scheduling = await scheduleDiscussionMaintenance(ctx, index);
	await index.flush(ctx, index.control?.witnessThreadId ?? null, scheduling, false);
	return { status: 'preparing', operationId: input.args.operationId };
}

/** Every unit reauthorizes the real original actor, ownership, source and native fences. */
export async function advanceEmailOperation(ctx: MutationCtx, original: Doc<'operationReceipts'>) {
	if (await expireOperation(ctx, original)) return;
	const { contract, access } = await authorizePreparedOperation(ctx, original);
	if (!access) throw new Error('Review snapshot requires the original seller.');
	const stored = await receiptPayload(ctx, original),
		input = JSON.parse(stored.inputs) as EmailInput,
		progress = original.emailPreparation;
	if (
		!progress ||
		input.kind !== original.kind ||
		input.args.operationId !== original.operationId ||
		input.args.id !== contract.root._id ||
		input.args.membershipId !== access.membershipId ||
		actionKey(access, input.kind, input.args.operationId) !== original.key
	)
		throw new Error('Original review operation ownership changed.');
	const delivery = await ctx.db.get('emailDeliveries', progress.deliveryId);
	if (
		!delivery ||
		!('snapshot' in delivery) ||
		delivery.snapshot.state !== 'staging' ||
		delivery.snapshot.receiptId !== original._id ||
		delivery.snapshot.ownerKey !== original.key ||
		delivery.companyId !== original.companyId ||
		delivery.contractId !== contract.root._id ||
		delivery.snapshot.generation !== progress.generation ||
		JSON.stringify(delivery.snapshot.actor) !== JSON.stringify(original.actor) ||
		delivery.snapshot.operationId !== original.operationId ||
		delivery.event.context !== input.args.context ||
		delivery.event.identity !== input.args.expectedIdentity ||
		delivery.event.buyerToken !== input.args.token ||
		delivery.event.kind !== (input.kind === 'approval-request' ? 'approval' : 'decision')
	)
		throw new Error('Staged delivery ownership changed.');
	const snapshot = delivery.snapshot,
		index = await DiscussionIndex.open(ctx, contract.root),
		summary = await reviewSet(ctx, contract, input.args.context);
	await ownedReviewLink(ctx, contract, input.args.context, input.args.token);
	if (
		summary.identity !== input.args.expectedIdentity ||
		summary.identity !== snapshot.contextIdentity ||
		contract.root.documentId !== snapshot.sourceDocumentId ||
		contract.root.documentRevision !== snapshot.documentRevision ||
		contract.root.stateRevision !== snapshot.stateRevision ||
		index.supportIndexGeneration !== snapshot.supportGeneration ||
		index.nativeStorageGeneration !== snapshot.storageGeneration ||
		(input.kind === 'approval-request' ? summary.pendingCount : summary.count) !== snapshot.count ||
		(input.kind === 'review-completion' &&
			(!summary.complete || access.membership.role !== 'admin'))
	)
		throw new ConvexError('The review changed. Review the current changes before submitting.');
	if (progress.done)
		return finishSnapshot(ctx, contract, access, input, delivery, progress, index, original);
	await admitDiscussionWork(ctx, { reads: 320, queries: 320, readBytes: 12 * 1024 * 1024 });
	const page = await nativeReviewPage(
			ctx,
			contract,
			input.args.context,
			delivery.event.kind,
			progress.cursor,
			index
		),
		chunks = planSnapshotChunks(
			access.companyId,
			delivery._id,
			progress.generation,
			page.entries,
			progress
		),
		next = {
			...progress,
			unit: progress.unit + 1,
			dueAt: Math.max(Date.now(), progress.dueAt + 1),
			cursor: page.continueCursor,
			done: page.isDone,
			order: progress.order + chunks.rows.length,
			count: progress.count + chunks.count,
			bytes: progress.bytes + chunks.bytes,
			hash: chunks.hash
		};
	if (next.count > snapshot.count || (next.done && next.count !== snapshot.count))
		throw new Error('Staged review snapshot count differs from its committed summary.');
	await reserve(
		ctx,
		chunks.work.writes + 1,
		chunks.work.bytes + documentBytes({ ...original, emailPreparation: next })
	);
	await writeSnapshotChunks(ctx, chunks);
	await ctx.db.patch('operationReceipts', original._id, { emailPreparation: next });
	return null;
}
