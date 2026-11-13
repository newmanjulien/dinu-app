import { ConvexError, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { availableCompany, liveProfile, membershipForProfile, type CompanyAccess } from './auth';
import { readContract, type Contract } from './contractState';
import { actionKey, receiptPayload, remember, receiptChunkFingerprint } from './operationReceipts';
import {
	nativePreparationKind,
	preparationActor,
	initialNativeValidation
} from './discussionPreparationValidators';
import { DiscussionIndex } from './discussionIndex';
import {
	DiscussionPreparationRequired,
	admitDiscussionWork,
	retireDiscussionMap,
	sealedDiscussionMap,
	stageDiscussionMap,
	type TransitionManifest
} from './discussionMaps';
import { scheduleDiscussionMaintenance } from './discussionMaintenance';
import type { DiscussionMap } from '../lib/discussions/tape';
import { emptySupportCounts } from './discussionSupportTree';
import { queueNativeCleanup } from './nativeConstructionCleanup';

export type NativePreparationKind = Infer<typeof nativePreparationKind>;
export type PreparationActor = Infer<typeof preparationActor>;
export const sellerPreparationActor = (
	access: CompanyAccess
): Extract<PreparationActor, { kind: 'seller' }> => ({
	kind: 'seller',
	membershipId: access.membershipId,
	profileId: access.profile._id,
	identity: access.profile.identity,
	role: access.membership.role
});
export function nativeOperationKey(
	access: CompanyAccess,
	kind: NativePreparationKind,
	operationId: string
) {
	return actionKey(access, kind === 'playbook-save' ? 'save' : kind, operationId);
}

/** Background work reauthorizes the stored real actor; a receipt never grants access. */
export async function authorizePreparedOperation(
	ctx: QueryCtx,
	row: Pick<Doc<'operationReceipts'>, 'contractId' | 'companyId' | 'actor' | 'operationId'>
): Promise<{
	contract: Contract;
	access: CompanyAccess | null;
	actor: PreparationActor;
}> {
	if (!row.contractId || !row.actor || !row.operationId)
		throw new Error('Pending operation ownership is incomplete.');
	const [root, company, deletion] = await Promise.all([
		ctx.db.get('savedContracts', row.contractId),
		availableCompany(ctx, row.companyId),
		ctx.db
			.query('contractCleanups')
			.withIndex('by_contractId', (q) => q.eq('contractId', row.contractId!))
			.unique()
	]);
	if (!root || root.companyId !== row.companyId || !company || deletion)
		throw new ConvexError('This contract is unavailable.');
	const actor = row.actor;
	const linkIdentity =
		actor.kind === 'buyer' ? { id: actor.linkId, token: actor.token } : actor.link;
	if (linkIdentity) {
		const link = await ctx.db.get('buyerLinks', linkIdentity.id);
		if (
			!link?.currentView ||
			link.companyId !== row.companyId ||
			link.contractId !== root._id ||
			link.token !== linkIdentity.token
		)
			throw new ConvexError('This link is unavailable.');
	}
	let access: CompanyAccess | null = null;
	if (actor.kind === 'seller') {
		const [profile, membership] = await Promise.all([
			liveProfile(ctx, actor.profileId),
			membershipForProfile(ctx, actor.profileId)
		]);
		if (
			!profile ||
			profile.identity !== actor.identity ||
			!membership ||
			membership._id !== actor.membershipId ||
			membership.companyId !== company._id ||
			membership.role !== actor.role
		)
			throw new ConvexError('Your company access has changed. Reload to continue.');
		access = {
			profile,
			membership,
			company,
			companyId: company._id,
			membershipId: membership._id,
			isOwner: company.ownerProfileId === profile._id
		};
	}
	return { contract: await readContract(ctx, root), access, actor };
}

/** Native identity includes exact affected message revisions/counts. Exclusions are
 * command-bounded; this never enumerates all threads in a contract. */
export type DiscussionPreparationPlan = {
	nativePlanPending?: boolean;
	index: DiscussionIndex;
	sourceDocumentId: Id<'contractDocuments'>;
	nativeStateRevision: number;
	planIdentity: string;
	proofIdentity: string;
	geometry?: { map: DiscussionMap; manifest: TransitionManifest };
	excluding: readonly Doc<'discussionThreads'>[];
};
export function preparedDiscussionProof(
	row: Doc<'operationReceipts'> | undefined,
	plan: DiscussionPreparationPlan
) {
	const prepared = row?.preparation;
	return prepared &&
		!prepared.nativePlanPending &&
		prepared.sourceDocumentId === plan.sourceDocumentId &&
		prepared.sourceDocumentRevision === plan.index.root.documentRevision &&
		prepared.nativeStateRevision === plan.nativeStateRevision &&
		prepared.planIdentity === plan.planIdentity &&
		prepared.proofIdentity === plan.proofIdentity &&
		prepared.indexGeneration === plan.index.indexGeneration &&
		prepared.proofComplete &&
		prepared.supportComplete &&
		prepared.supportGeneration === plan.index.supportIndexGeneration &&
		prepared.storageGeneration === plan.index.nativeStorageGeneration &&
		prepared.requestId === (plan.index.supportSummary.request?.id ?? null) &&
		prepared.requestCutoff === (plan.index.supportSummary.request?.cutoff ?? null) &&
		(prepared.map?.geometryHash ?? null) === (plan.geometry?.manifest.geometryHash ?? null) &&
		(!prepared.map || sealedDiscussionMap(prepared.map, prepared.mapCursor))
		? prepared
		: null;
}

/** Called only when the native command yielded before business writes. Chunk/cursor
 * progress and the shared continuation commit together on its original receipt. */
export async function deferDiscussionOperation(
	ctx: MutationCtx,
	args: {
		contract: Contract;
		actor: PreparationActor;
		kind: NativePreparationKind;
		operationId: string;
		key: string;
		inputs: string;
		prior?: Doc<'operationReceipts'>;
		plan: DiscussionPreparationPlan;
	}
) {
	const { contract, plan } = args;
	const previous = args.prior?.preparation;
	const geometryMatches =
		previous?.sourceDocumentId === contract.root.documentId &&
		previous.sourceDocumentRevision === contract.root.documentRevision &&
		previous.nativeStateRevision === contract.root.stateRevision &&
		previous.planIdentity === plan.planIdentity &&
		(previous.map?.geometryHash ?? null) === (plan.geometry?.manifest.geometryHash ?? null);
	const proofMatches =
		geometryMatches &&
		previous.proofIdentity === plan.proofIdentity &&
		previous.indexGeneration === plan.index.indexGeneration;
	const supportMatches =
		geometryMatches &&
		previous.proofIdentity === plan.proofIdentity &&
		previous.supportGeneration === plan.index.supportIndexGeneration &&
		previous.storageGeneration === plan.index.nativeStorageGeneration &&
		previous.requestId === (plan.index.supportSummary.request?.id ?? null) &&
		previous.requestCutoff === (plan.index.supportSummary.request?.cutoff ?? null);
	let preparation: NonNullable<Doc<'operationReceipts'>['preparation']> = {
		...(previous?.sourceDocumentId === contract.root.documentId &&
		previous.sourceDocumentRevision === contract.root.documentRevision
			? { sourcePassage: previous.sourcePassage, passageJobId: previous.passageJobId }
			: {}),
		nativePlanPending: plan.nativePlanPending ?? false,
		nativeGeneration: previous?.nativeGeneration ?? -1,
		...(plan.nativePlanPending &&
		['playbook-save', 'change-decision', 'proposal-support'].includes(args.kind)
			? {
					native:
						geometryMatches &&
						previous?.native &&
						previous.supportGeneration === plan.index.supportIndexGeneration &&
						previous.storageGeneration === plan.index.nativeStorageGeneration
							? previous.native
							: initialNativeValidation(
									(previous?.nativeGeneration ?? -1) + 1,
									receiptChunkFingerprint(
										JSON.stringify([
											args.key,
											args.inputs,
											args.actor,
											contract.root.documentId,
											contract.root.documentRevision,
											contract.root.stateRevision,
											plan.index.supportIndexGeneration,
											plan.index.nativeStorageGeneration
										])
									)
								)
				}
			: {}),
		sourceDocumentId: contract.root.documentId,
		sourceDocumentRevision: contract.root.documentRevision,
		nativeStateRevision: contract.root.stateRevision,
		planIdentity: plan.planIdentity,
		proofIdentity: plan.proofIdentity,
		...(geometryMatches && previous.map
			? { map: previous.map, ...(previous.mapCursor ? { mapCursor: previous.mapCursor } : {}) }
			: plan.geometry
				? { map: plan.geometry.manifest }
				: {}),
		proofCursor: proofMatches ? previous.proofCursor : { cohort: 0, frames: [] },
		indexGeneration: plan.index.indexGeneration,
		proofComplete: proofMatches ? previous.proofComplete : false,
		supportCursor: supportMatches
			? previous.supportCursor
			: {
					geometry: { cohort: 0, frames: [] },
					counts: emptySupportCounts()
				},
		supportComplete: supportMatches ? previous.supportComplete : false,
		supportGeneration: plan.index.supportIndexGeneration,
		storageGeneration: plan.index.nativeStorageGeneration,
		requestId: plan.index.supportSummary.request?.id ?? null,
		requestCutoff: plan.index.supportSummary.request?.cutoff ?? null,
		witnessThreadId: proofMatches ? previous.witnessThreadId : null,
		restartGeneration: (previous?.restartGeneration ?? 0) + (previous && !proofMatches ? 1 : 0),
		dueAt: Math.max(Date.now(), (previous?.dueAt ?? 0) + 1)
	};
	// Direct discussion commands prepare their bounded exact support delta in memory;
	// no document-wide support fold is needed for an acknowledgment or source edit.
	if (
		(args.kind === 'discussion-write' || args.kind === 'discussion-mark-seen') &&
		!plan.geometry
	) {
		const summary = plan.index.supportSummary;
		preparation.supportComplete = true;
		preparation.supportCursor = {
			geometry: { cohort: 0, frames: [] },
			counts: {
				supportCount: summary.supportCount,
				pendingCount: summary.pendingCount,
				declinedCount: summary.declinedCount,
				withAppliedCount: summary.withAppliedCount,
				coveredPendingCount: summary.coveredPendingCount
			}
		};
	}
	preparation.nativeGeneration = preparation.native?.generation ?? preparation.nativeGeneration;
	// Initial admission preserves intent promptly; bounded batches use the durable chain.
	if (args.prior && !preparation.nativePlanPending && plan.index.events.length < 8) {
		try {
			if (
				plan.geometry &&
				preparation.map &&
				!preparation.map.inline &&
				preparation.map.chunkCount <= 0
			) {
				const staged = await stageDiscussionMap(
					ctx,
					plan.index.owner,
					plan.geometry.map,
					preparation.map,
					preparation.mapCursor
				);
				preparation = { ...preparation, map: staged.manifest, mapCursor: staged.cursor };
			}
			if (!preparation.map || sealedDiscussionMap(preparation.map, preparation.mapCursor)) {
				if (!preparation.proofComplete) {
					const cached = await plan.index.validWitness(preparation.map, plan.excluding);
					if (cached)
						preparation = { ...preparation, witnessThreadId: cached, proofComplete: true };
				}
				for (let step = 0; step < 32 && !preparation.proofComplete; step++) {
					await admitDiscussionWork(ctx, { reads: 16, queries: 16 });
					const proof = await plan.index.proofStep(
						preparation.proofCursor,
						preparation.map,
						plan.excluding
					);
					preparation = {
						...preparation,
						proofCursor: proof.cursor,
						proofComplete: proof.done,
						witnessThreadId: proof.witness
					};
				}
				for (let step = 0; step < 32 && !preparation.supportComplete; step++) {
					await admitDiscussionWork(ctx, { reads: 16, queries: 16 });
					const proof = await plan.index.supportProofStep(
						preparation.supportCursor,
						preparation.map,
						plan.excluding
					);
					preparation = {
						...preparation,
						supportCursor: proof.cursor,
						supportComplete: proof.done
					};
				}
			}
		} catch (error) {
			if (!(error instanceof DiscussionPreparationRequired)) throw error;
			// A failed current step never advanced its cursor; completed steps remain durable.
		}
	}
	if (args.prior) {
		const live = await ctx.db.get('operationReceipts', args.prior._id);
		if (
			!live ||
			live.state !== 'preparing' ||
			live.key !== args.key ||
			live.companyId !== contract.root.companyId
		)
			throw new Error('Pending operation identity changed.');
		if ((await receiptPayload(ctx, live)).inputs !== args.inputs)
			throw new Error('Pending operation input changed.');
		await ctx.db.patch('operationReceipts', live._id, { preparation });
		if (previous?.map && !geometryMatches)
			await retireDiscussionMap(ctx, plan.index.owner, previous.map);
		if (previous?.native && previous.native.generation !== preparation.native?.generation)
			await queueNativeCleanup(ctx, live._id, previous.native.generation);
	} else
		await remember(
			ctx,
			contract.root.companyId,
			args.key,
			args.inputs,
			'',
			{
				contractId: contract.root._id,
				kind: args.kind
			},
			{ actor: args.actor, operationId: args.operationId, preparation }
		);
	const scheduling = await scheduleDiscussionMaintenance(ctx, plan.index);
	await plan.index.flush(ctx, plan.index.control?.witnessThreadId ?? null, scheduling, false);
	return { status: 'preparing' as const, operationId: args.operationId };
}
