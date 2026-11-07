import { v } from 'convex/values';
import { sourceTarget } from '../lib/contract/source-validators';
import { PlaybookGeometryIndex } from '../lib/playbook/geometry-index';
import { MAX_PLAYBOOK_ITEMS } from '../lib/playbook/limits';
import type { PlaybookItem } from '../lib/playbook/model';
import { playbookStructure, structureGeometry, type DetailRecord } from '../lib/playbook/structure';
import { equalItemStructure } from '../lib/playbook/structure-codec';
import {
	validateChangeReferences,
	validateConcessionUpdate,
	validatePlaybookItemContent,
	validateStructuralReplacementContent
} from '../lib/playbook/validation';
import { PlaybookValidationError } from '../lib/playbook/validation-error';
import type { Doc } from './_generated/dataModel';
import { mutation, query, type QueryCtx } from './_generated/server';
import { requireMembership, requirePermission, scopedOperation } from './auth';
import {
	readValidationFacts,
	validationCertified,
	readValidationCertificate
} from './authoringValidation';
import {
	compactHead,
	createAuthoringItem,
	headStructure,
	hydrateHead,
	itemRevision,
	markDraftItemRevision,
	replaceDraftItemRevision,
	storeItemRevision
} from './playbookItemRevisions';
import { hydratedPlaybookItem, playbookItem, trigger } from './playbookValidators';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { templateRejected } from './templateCapacity';
import {
	addTemplateReadBytes,
	currentDetails,
	orderedHeads,
	versionReferences,
	currentPointer,
	isMutableTemplateVersion,
	readAuthoringVersion,
	saveChangedVersion
} from './templates';

const watermark = {
	baselineFingerprint: v.string(),
	authoringGeneration: v.number(),
	structuralGeneration: v.number()
};
const structureItem = v.object({
	_id: v.id('playbookItems'),
	_creationTime: v.number(),
	companyId: v.id('company'),
	contentRevision: v.number(),
	renderKey: v.string(),
	trigger,
	concessions: v.array(
		v.object({
			id: v.string(),
			changes: v.array(
				v.object({ target: sourceTarget, paragraphBreaks: v.number(), meaningful: v.boolean() })
			)
		})
	)
});
const conflict = v.object({
	status: v.literal('conflict'),
	item: hydratedPlaybookItem,
	...watermark
});
const missing = v.object({ status: v.literal('missing') });
async function observation(ctx: QueryCtx, company: Doc<'company'>) {
	const pointer = await currentPointer(ctx, company._id);
	const [baseline, version, certificate] = await Promise.all([
		company.baselineId ? ctx.db.get('baselines', company.baselineId) : null,
		pointer ? ctx.db.get('templateVersions', pointer.versionId) : null,
		company.baselineId ? readValidationCertificate(ctx, company._id, company.baselineId) : null
	]);
	const ready = Boolean(
		!company.authoringMigration &&
		baseline &&
		version &&
		baseline.companyId === company._id &&
		version.companyId === company._id &&
		baseline._id === version.baselineId &&
		baseline.blockCount === version.blockCount &&
		pointer?.authoringGeneration === version.authoringGeneration &&
		pointer?.structuralGeneration === version.structuralGeneration &&
		baseline.state === 'active' &&
		validationCertified(baseline, certificate, version)
	);
	return {
		pointer,
		baseline,
		version,
		ready,
		baselineFingerprint: baseline?.fingerprint ?? '',
		authoringGeneration: pointer?.authoringGeneration ?? version?.authoringGeneration ?? 0,
		structuralGeneration: pointer?.structuralGeneration ?? version?.structuralGeneration ?? 0
	};
}
function observed({
	baselineFingerprint,
	authoringGeneration,
	structuralGeneration
}: Awaited<ReturnType<typeof observation>>) {
	return { baselineFingerprint, authoringGeneration, structuralGeneration };
}
async function committed(ctx: QueryCtx, company: Doc<'company'>) {
	return observed(await observation(ctx, company));
}
function rejection(error: unknown) {
	if (!(error instanceof PlaybookValidationError)) throw error;
	return { status: 'rejected' as const, message: error.message };
}
/** Build buckets from certified structure, then validate only the changed relationships. */
async function validateStructure(
	ctx: QueryCtx,
	captured: Awaited<ReturnType<typeof readAuthoringVersion>>,
	item: PlaybookItem,
	previous?: DetailRecord
) {
	const { baseline, version } = captured;
	if (
		(version.headReadBytes ?? 0) +
			captured.certificate.readBytes +
			documentBytes(captured.certificate) +
			documentBytes(version) +
			documentBytes(baseline) +
			2_100_000 >
		16 * 1024 * 1024
	)
		throw templateRejected('Template structure exceeds supported read capacity.');
	const [contract, heads] = await Promise.all([
		readValidationFacts(ctx, baseline, captured.certificate),
		ctx.db
			.query('playbookItems')
			.withIndex('by_companyId', (q) => q.eq('companyId', version.companyId))
			.take(MAX_PLAYBOOK_ITEMS + 1)
	]);
	const ordered = orderedHeads(version, heads);
	const geometry = new PlaybookGeometryIndex(contract);
	geometry.loadCertified(
		ordered.map((head) => [head._id, structureGeometry(headStructure(head))] as const)
	);
	validateStructuralReplacementContent(item);
	validateChangeReferences(contract, item);
	geometry.validateTriggersReplacing(previous?._id, [item.trigger]);
	for (const concession of item.concessions)
		geometry.validateChanges(concession.changes, previous?._id, [item.trigger]);
}
/** All ordinary authoring uses one metadata/delta writer; no baseline prose or snapshot serialization. */
export const savePlaybookItem = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.optional(v.id('playbookItems')),
		item: playbookItem,
		expectedContentRevision: v.number(),
		operationId: v.string()
	},
	returns: v.union(
		v.object({ status: v.literal('saved'), item: hydratedPlaybookItem, ...watermark }),
		conflict,
		v.object({ status: v.literal('rejected'), message: v.string() }),
		missing
	),
	handler: async (ctx, { membershipId, id, item, expectedContentRevision, operationId }) => {
		const access = await requirePermission(ctx, 'manageTemplate', membershipId);
		if (
			!Number.isSafeInteger(expectedContentRevision) ||
			expectedContentRevision < 0 ||
			!/^[0-9a-f-]{36}$/i.test(operationId)
		)
			throw new Error('Invalid save operation');
		let head = id ? await ctx.db.get('playbookItems', id) : null;
		if (!id) {
			const receipt = await ctx.db
				.query('playbookItemCreationReceipts')
				.withIndex('by_operationId', (q) =>
					q.eq('operationId', scopedOperation(access, operationId))
				)
				.unique();
			if (receipt) {
				head = await ctx.db.get('playbookItems', receipt.itemId);
				if (!head || head.companyId !== access.companyId) return { status: 'missing' as const };
				const current = await hydrateHead(ctx, head);
				return head.lastOperation?.id === operationId &&
					head.lastOperation.callerId === access.profile._id
					? { status: 'saved' as const, item: current, ...(await committed(ctx, access.company)) }
					: {
							status: 'conflict' as const,
							item: current,
							...(await committed(ctx, access.company))
						};
			}
			const identity = await ctx.db
				.query('playbookItemCreationReceipts')
				.withIndex('by_companyId_and_renderKey', (q) =>
					q.eq('companyId', access.companyId).eq('renderKey', operationId)
				)
				.unique();
			if (identity)
				return {
					status: 'rejected' as const,
					message:
						'Another save already used this operation. Restore the draft to submit a new save.'
				};
		} else if (!head || head.companyId !== access.companyId) return { status: 'missing' as const };
		const currentRevision = head?.currentRevisionId
			? await ctx.db.get('playbookItemRevisions', head.currentRevisionId)
			: null;
		const current = head ? await hydrateHead(ctx, head, currentRevision) : null;
		if (
			current?.lastOperation?.id === operationId &&
			current.lastOperation.callerId === access.profile._id
		)
			return { status: 'saved' as const, item: current, ...(await committed(ctx, access.company)) };
		if (current && current.contentRevision !== expectedContentRevision)
			return {
				status: 'conflict' as const,
				item: current,
				...(await committed(ctx, access.company))
			};
		if (!current && expectedContentRevision !== 0) return { status: 'missing' as const };
		try {
			validatePlaybookItemContent(item);
			if (current) validateConcessionUpdate(current, item);
		} catch (error) {
			return rejection(error);
		}
		const captured = await readAuthoringVersion(ctx, access.company, current ?? undefined);
		if (!current && captured.version.itemCount >= MAX_PLAYBOOK_ITEMS)
			throw templateRejected('Playbook exceeds supported size.');
		const structuralChanged =
			!current || !equalItemStructure(playbookStructure(current), playbookStructure(item));
		if (structuralChanged) {
			try {
				await validateStructure(ctx, captured, item, current ?? undefined);
			} catch (error) {
				return rejection(error);
			}
		}
		const mutableVersionId = isMutableTemplateVersion(captured.version)
			? captured.version._id
			: undefined;
		let next: DetailRecord;
		let previousRevision: Doc<'playbookItemRevisions'> | null = null;
		let nextRevisionBytes: number;
		if (!current) {
			next = await createAuthoringItem(ctx, {
				...item,
				companyId: access.companyId,
				renderKey: operationId,
				lastOperation: { id: operationId, callerId: access.profile._id }
			});
			const receipt = {
				companyId: access.companyId,
				renderKey: operationId,
				operationId: scopedOperation(access, operationId),
				itemId: next._id
			};
			await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(receipt) });
			await ctx.db.insert('playbookItemCreationReceipts', receipt);
			nextRevisionBytes = documentBytes(
				(await ctx.db.get('playbookItemRevisions', next.currentRevisionId!))!
			);
		} else {
			previousRevision = currentRevision;
			if (!previousRevision) throw templateRejected('The saved rule revision is missing.');
			const proposed: DetailRecord = {
				...item,
				_id: current._id,
				_creationTime: current._creationTime,
				companyId: access.companyId,
				contentRevision: current.contentRevision + 1,
				renderKey: current.renderKey,
				lastOperation: { id: operationId, callerId: access.profile._id }
			};
			const currentRevisionId =
				mutableVersionId && previousRevision.mutableVersionId === mutableVersionId
					? await replaceDraftItemRevision(ctx, previousRevision._id, proposed, mutableVersionId)
					: await storeItemRevision(ctx, proposed, mutableVersionId);
			next = { ...proposed, currentRevisionId };
			nextRevisionBytes = documentBytes({
				...itemRevision(proposed),
				...(mutableVersionId ? { mutableVersionId } : {}),
				_id: currentRevisionId,
				_creationTime: 0
			});
		}
		const packedHead = compactHead(next);
		if (current) {
			await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(packedHead) });
			await ctx.db.replace('playbookItems', current._id, packedHead);
		}
		const versionId = await saveChangedVersion(
			ctx,
			captured,
			current,
			next,
			{ previous: previousRevision ? documentBytes(previousRevision) : 0, next: nextRevisionBytes },
			structuralChanged,
			{
				previous: head ? documentBytes(head) : 0,
				next: documentBytes({
					...packedHead,
					_id: next._id,
					_creationTime: next._creationTime
				})
			}
		);
		if (!mutableVersionId || !current) {
			const delta = await markDraftItemRevision(ctx, next.currentRevisionId!, versionId);
			await addTemplateReadBytes(ctx, versionId, captured.baseline, delta);
		}
		return { status: 'saved' as const, item: next, ...(await committed(ctx, access.company)) };
	}
});
export const deletePlaybookItem = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('playbookItems'),
		expectedContentRevision: v.number()
	},
	returns: v.union(v.object({ status: v.literal('deleted'), ...watermark }), conflict),
	handler: async (ctx, { membershipId, id, expectedContentRevision }) => {
		const access = await requirePermission(ctx, 'manageTemplate', membershipId);
		const head = await ctx.db.get('playbookItems', id);
		if (head && head.companyId !== access.companyId) throw new Error('This item is unavailable.');
		if (!head) return { status: 'deleted' as const, ...(await committed(ctx, access.company)) };
		const revision = head.currentRevisionId
			? await ctx.db.get('playbookItemRevisions', head.currentRevisionId)
			: null;
		const current = await hydrateHead(ctx, head, revision);
		if (current.contentRevision !== expectedContentRevision)
			return {
				status: 'conflict' as const,
				item: current,
				...(await committed(ctx, access.company))
			};
		const captured = await readAuthoringVersion(ctx, access.company, current);
		if (!revision) throw templateRejected('The saved rule revision is missing.');
		// Removing a trigger can only relax ownership: unowned changes are valid by design.
		await assertStorageCapacity(ctx, { documents: 1 });
		await ctx.db.delete('playbookItems', id);
		await saveChangedVersion(
			ctx,
			captured,
			current,
			null,
			{ previous: documentBytes(revision), next: 0 },
			true,
			{ previous: documentBytes(head), next: 0 }
		);
		if (
			isMutableTemplateVersion(captured.version) &&
			revision.mutableVersionId === captured.version._id
		)
			await ctx.db.delete('playbookItemRevisions', revision._id);
		return { status: 'deleted' as const, ...(await committed(ctx, access.company)) };
	}
});
export const currentStructure = query({
	args: { membershipId: v.id('memberships') },
	returns: v.object({ ...watermark, ready: v.boolean(), items: v.array(structureItem) }),
	handler: async (ctx, { membershipId }) => {
		const access = await requireMembership(ctx, membershipId),
			state = await observation(ctx, access.company);
		if (!state.ready) return { ...observed(state), ready: false, items: [] };
		const heads = await ctx.db
			.query('playbookItems')
			.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
			.take(MAX_PLAYBOOK_ITEMS + 1);
		const ordered = orderedHeads(state.version!, heads);
		return {
			...observed(state),
			ready: true,
			items: ordered.map((head) => ({
				_id: head._id,
				_creationTime: head._creationTime,
				companyId: head.companyId,
				contentRevision: head.contentRevision,
				renderKey: 'format' in head ? head.renderKey : head._id,
				...headStructure(head)
			}))
		};
	}
});
export const detail = query({
	args: { membershipId: v.id('memberships'), id: v.id('playbookItems') },
	returns: v.union(
		v.object({
			...watermark,
			ready: v.boolean(),
			status: v.literal('present'),
			item: hydratedPlaybookItem
		}),
		v.object({ ...watermark, ready: v.boolean(), status: v.literal('missing') })
	),
	handler: async (ctx, { membershipId, id }) => {
		const access = await requireMembership(ctx, membershipId),
			state = await observation(ctx, access.company);
		const head = await ctx.db.get('playbookItems', id);
		if (state.ready) {
			const reference = versionReferences(state.version!).get(id);
			if (
				reference
					? !head ||
						head.companyId !== access.companyId ||
						head.currentRevisionId !== reference.revisionId
					: head?.companyId === access.companyId
			)
				throw templateRejected('The saved rule revision is missing.');
		}
		if (!head || head.companyId !== access.companyId)
			return { ...observed(state), ready: state.ready, status: 'missing' as const };
		return {
			...observed(state),
			ready: state.ready,
			status: 'present' as const,
			item: await hydrateHead(ctx, head)
		};
	}
});
export const current = query({
	args: { membershipId: v.id('memberships') },
	returns: v.array(hydratedPlaybookItem),
	handler: async (ctx, { membershipId }) => {
		const access = await requireMembership(ctx, membershipId);
		return currentDetails(ctx, access.companyId);
	}
});
export { list } from './legacyPlaybook';
