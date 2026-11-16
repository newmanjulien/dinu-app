import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import type { Contract } from './contractState';
import type { SessionHead, TransitionHooks, TransitionPlan } from './contractChanges';
import { DiscussionIndex } from './discussionIndex';
import { effectiveBuyerSource } from './buyerSupportEligibility';
import { ConvexError } from 'convex/values';
import { documentBytes } from './storageCapacity';
import type { SupportCounts, SupportEntry } from './discussionSupportTree';
import {
	DiscussionPreparationRequired,
	admitDiscussionWork,
	discussionMapManifest,
	type TransitionManifest
} from './discussionMaps';
import { scheduleDiscussionMaintenance } from './discussionMaintenance';
import { preparedDiscussionProof, type DiscussionPreparationPlan } from './discussionPreparation';
import { discussionTape, discussionTransition, type DiscussionMap } from '../lib/discussions/tape';

/** Focused bridge from the native transition to exact shared discussions. Every read
 * that can defer precedes engine writes; afterChanges only adopts admitted effects. */
export function discussionTransitionHooks(
	ctx: MutationCtx,
	contract: Contract,
	options: {
		receipt?: Doc<'operationReceipts'>;
		hooks?: TransitionHooks;
		index?: DiscussionIndex;
		deferFlush?: boolean;
	} = {}
) {
	let index: DiscussionIndex | undefined = options.index;
	let geometry: DiscussionMap | undefined;
	let manifest: TransitionManifest | undefined;
	let witness: Doc<'discussionThreads'>['_id'] | null = null;
	let record = false;
	let businessWritesStarted = false;
	let pending: DiscussionPreparationPlan | undefined;
	let supportCounts: SupportCounts | undefined;
	let buyerEffects: Awaited<ReturnType<typeof prepareBuyerHeadEffects>> | undefined;
	const open = async () =>
		(index ??= await DiscussionIndex.open(ctx, contract.root, () =>
			admitDiscussionWork(ctx, { reads: 1, queries: 1 })
		));
	function map(plan: Pick<TransitionPlan, 'before' | 'after'>) {
		if (!plan.before || !plan.after)
			throw new Error('A document transition requires its materialized source.');
		return (geometry ??= discussionTransition(
			discussionTape(plan.before),
			discussionTape(plan.after)
		));
	}
	const hooks: TransitionHooks = {
		beforePlan: options.hooks?.beforePlan,
		beforeCommit: async (plan) => {
			const external = await options.hooks?.beforeCommit?.(plan);
			const buyerHeads = plan.heads.filter((value) => value.kind === 'buyer-link');
			if (!plan.documentChanged && !buyerHeads.length) return external;
			const current = await open();
			const live =
				current.events.length ||
				(await ctx.db
					.query('discussionThreads')
					.withIndex('by_contractId_and_tombstoned_and_indexedDocumentRevision', (q) =>
						q.eq('contractId', contract.root._id).eq('tombstoned', false)
					)
					.first());
			if (!live && !buyerHeads.length) return external;
			record = Boolean(live) && plan.documentChanged;
			if (record) {
				const transition = map(plan);
				manifest = discussionMapManifest(
					transition,
					JSON.stringify([contract.root.documentId, contract.root.documentRevision, plan.identity])
				);
				pending = {
					index: current,
					sourceDocumentId: contract.root.documentId,
					nativeStateRevision: contract.root.stateRevision,
					planIdentity: plan.identity,
					proofIdentity: plan.identity,
					geometry: { map: transition, manifest },
					excluding: []
				};
				if (current.events.length >= 8) throw new DiscussionPreparationRequired('event-slots');
				if (options.receipt) {
					const proof = preparedDiscussionProof(options.receipt, pending);
					if (!proof) throw new DiscussionPreparationRequired('unread-proof');
					manifest = proof.map!;
					witness = proof.witnessThreadId;
					supportCounts = proof.supportCursor.counts;
				} else {
					if (!manifest.inline) throw new DiscussionPreparationRequired('map-build');
					witness = await current.witness(manifest);
					supportCounts = await current.effectiveSupportCounts(manifest);
				}
				if (
					supportCounts.supportCount < current.supportSummary.supportCount &&
					!plan.changedContexts.includes('buyer-link')
				)
					plan.changedContexts.push('buyer-link');
				plan.supportCommitment = supportCounts;
			}
			if (supportCounts) current.installSupportCounts(supportCounts);
			buyerEffects = await prepareBuyerHeadEffects(
				ctx,
				current,
				buyerHeads.map((value) => ({
					old: value.initial ?? null,
					nextCurrent: value.current?.row ?? null,
					nextApplied: value.applied?.row ?? null,
					floating: Boolean(value.current && value.current !== value.applied),
					decisionStatus: value.currentDecision?.row.status ?? null,
					currentId: () => value.current?.id ?? null,
					decisionId: () =>
						value.currentDecision
							? (value.currentDecision.id ?? ('x'.repeat(32) as Id<'contractChangeDecisions'>))
							: null
				})),
				plan.sourceTapeLength ??
					(plan.before
						? discussionTape(plan.before).length
						: (() => {
								throw new Error('Missing source-only tape length.');
							})()),
				contract.root.stateRevision + 1,
				manifest
			);
			if (buyerHeads.length) plan.supportCommitment = buyerEffects.counts;
			plan.buyerReviewCount = current.supportSummary.reviewCount;
			// Admit the bounded adoption and tree/control writes before any native engine write.
			await admitDiscussionWork(ctx, { writes: 4, bytes: 16_384, reads: 4, queries: 4 });
			return record ? { ...external, hasUnreadComment: Boolean(witness) } : external;
		},
		reserve: async (plan) => {
			const external = (await options.hooks?.reserve?.(plan)) ?? {};
			if (!index) return external;
			const tree = await index.prepareFlush(
				record ? witness : (index.control?.witnessThreadId ?? null),
				record
			);
			return {
				...external,
				documents: (external.documents ?? 0) + tree.documents + (record ? 2 : 0),
				bytes:
					(external.bytes ?? 0) +
					tree.bytes +
					(record && manifest
						? documentBytes({
								...index.owner,
								fromRevision: contract.root.documentRevision,
								toRevision: contract.root.documentRevision + 1,
								map: manifest
							}) + 4096
						: 0),
				queries: (external.queries ?? 0) + (record ? 4 : 0),
				readDocuments: (external.readDocuments ?? 0) + (record ? 4 : 0),
				readBytes: (external.readBytes ?? 0) + (record ? 64 * 1024 : 0),
				functionsScheduled: (external.functionsScheduled ?? 0) + Number(record),
				scheduledFunctionArgsBytes: (external.scheduledFunctionArgsBytes ?? 0) + (record ? 4096 : 0)
			};
		},
		afterChanges: async (plan) => {
			businessWritesStarted = true;
			await options.hooks?.afterChanges?.(plan);
			buyerEffects?.bind();
			if (record) {
				if (!index || !manifest) throw new Error('Missing admitted discussion transition.');
				await index.recordTransition(ctx, manifest);
				const scheduling = await scheduleDiscussionMaintenance(ctx, index);
				await index.flush(ctx, witness, scheduling, false);
			} else if (buyerEffects && index && !options.deferFlush) {
				await index.flush(ctx, index.control?.witnessThreadId ?? null, undefined, false);
			} else if (options.receipt?.preparation?.map) {
				const current = await open();
				await current.flush(
					ctx,
					current.control?.witnessThreadId ?? null,
					await scheduleDiscussionMaintenance(ctx, current),
					false
				);
			}
		},
		afterCommit: options.hooks?.afterCommit
	};
	return {
		hooks,
		get businessWritesStarted() {
			return businessWritesStarted;
		},
		get pending() {
			return pending;
		},
		deferredPlan: async (identity: string): Promise<DiscussionPreparationPlan> => {
			const fresh = await DiscussionIndex.open(ctx, contract.root);
			return pending
				? { ...pending, index: fresh }
				: {
						index: fresh,
						sourceDocumentId: contract.root.documentId,
						nativeStateRevision: contract.root.stateRevision,
						nativePlanPending: true,
						planIdentity: identity,
						proofIdentity: identity,
						excluding: []
					};
		},
		deferredNativePlan: async (identity: string): Promise<DiscussionPreparationPlan> => ({
			index: await DiscussionIndex.open(ctx, contract.root),
			sourceDocumentId: contract.root.documentId,
			nativeStateRevision: contract.root.stateRevision,
			nativePlanPending: true,
			planIdentity: identity,
			proofIdentity: identity,

			excluding: []
		})
	};
}

/** Prepare exact direct support overlays before native insertion. The retained entry
 * references bind allocated native IDs without another tree traversal or admission. */
export async function prepareBuyerHeadEffects(
	ctx: MutationCtx,
	index: DiscussionIndex,
	heads: {
		old: SessionHead['initial'] | null;
		nextCurrent:
			| import('convex/values').Infer<
					typeof import('./contractChangeValidators').storedContractChange
			  >
			| null;
		nextApplied:
			| import('convex/values').Infer<
					typeof import('./contractChangeValidators').storedContractChange
			  >
			| null;
		floating: boolean;
		decisionStatus: 'approved' | 'rejected' | null;
		currentId: () => Id<'contractChanges'> | null;
		decisionId: () => Id<'contractChangeDecisions'> | null;
	}[],
	tapeLength: number,
	admissionRevision: number,
	manifest?: TransitionManifest
) {
	const bindings: { entry: SupportEntry; head: (typeof heads)[number] }[] = [];
	for (const head of heads) {
		const old = head.old?.storedCurrent;
		const oldFloating = old?.kind === 'buyer-link' && old._id !== head.old?.applied?._id;
		const next = head.floating && head.nextCurrent?.kind === 'buyer-link' ? head.nextCurrent : null;
		if (next && !(await effectiveBuyerSource(ctx, index, next)))
			throw new ConvexError('This proposal changed. Review its current wording.');
		index.changeAppliedBuyerCount(
			Number(head.nextApplied?.policy === 'required') -
				Number(head.old?.applied?.policy === 'required')
		);
		const source = next?.source ?? (oldFloating && old?.kind === 'buyer-link' ? old.source : null);
		const thread = source ? await index.thread(source.threadId) : null;
		if (!thread) continue;
		const entry: SupportEntry | null = next
			? {
					start: thread.passageStart,
					end: thread.passageEnd,
					threadId: thread._id,
					changeId: head.currentId() ?? ('x'.repeat(32) as Id<'contractChanges'>),
					decisionId: head.decisionId(),
					rootMessageId: next.source.rootMessageId,
					rootRevision: next.source.rootRevision,
					status: head.decisionStatus === 'rejected' ? 'declined' : 'pending',
					admissionRevision,
					withApplied: head.nextApplied?.policy === 'required'
				}
			: null;
		await index.replaceSupport(thread, entry, tapeLength, {
			old: Boolean(
				oldFloating &&
				head.old?.current?._id === old?._id &&
				old?.kind === 'buyer-link' &&
				(await effectiveBuyerSource(ctx, index, old, manifest))
			),
			next: Boolean(next && (await effectiveBuyerSource(ctx, index, next, manifest)))
		});
		if (entry) bindings.push({ entry, head });
	}
	return {
		counts: {
			supportCount: index.supportSummary.supportCount,
			pendingCount: index.supportSummary.pendingCount,
			declinedCount: index.supportSummary.declinedCount,
			withAppliedCount: index.supportSummary.withAppliedCount,
			coveredPendingCount: index.supportSummary.coveredPendingCount
		},
		bind: () => {
			for (const { entry, head } of bindings) {
				const id = head.currentId();
				if (!id) throw new Error('Prepared support lost its native change ID.');
				entry.changeId = id;
				entry.decisionId = head.decisionId();
			}
		}
	};
}
