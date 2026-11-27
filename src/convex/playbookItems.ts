import { ConvexError, v } from 'convex/values';
import { sourceTarget } from '../lib/document/source-validators';
import { PlaybookGeometryIndex } from '../lib/playbook/geometry-index';
import { MAX_PLAYBOOK_ITEMS } from '../lib/playbook/limits';
import type { TemplateItem } from '../lib/playbook/model';
import { playbookStructure, type TemplateDetailRecord } from '../lib/playbook/structure';
import { equalItemStructure } from '../lib/playbook/structure-codec';
import {
	validateChangeReferences,
	validateConcessionUpdate,
	validateTemplateItemContent
} from '../lib/playbook/validation';
import { PlaybookValidationError } from '../lib/playbook/validation-error';
import { templateAudience, templateItem } from '../lib/playbook/validators';
import type { Doc } from './_generated/dataModel';
import { mutation, query, type QueryCtx } from './_generated/server';
import { requireMembership, requirePermission, scopedOperation } from './auth';
import {
	readValidationCertificate,
	readValidationFacts,
	validationCertified
} from './authoringValidation';
import {
	compactHead,
	createAuthoringItem,
	headStructure,
	hydrateHead,
	itemRevision,
	replaceDraftItemRevision,
	storeItemRevision,
	type UnrevisedDetailRecord
} from './playbookItemRevisions';
import { hydratedTemplateItem, trigger } from './playbookValidators';
import { documentBytes } from './storageCapacity';
import { templateRejected } from './templateCapacity';
import {
	currentPointer,
	isMutableTemplateVersion,
	nextTemplateGenerations,
	orderedAudienceHeads,
	readAuthoringVersion,
	saveChangedVersion,
	templateGenerations
} from './templates';

const sourceIdentity = {
	templateSourceId: v.union(v.id('templateSources'), v.null()),
	templateSourceFingerprint: v.string()
};
const watermark = {
	...sourceIdentity,
	authoringGeneration: v.number(),
	structuralGeneration: v.number()
};
const structureItem = v.object({
	_id: v.id('playbookItems'),
	_creationTime: v.number(),
	companyId: v.id('company'),
	contentRevision: v.number(),
	renderKey: v.string(),
	audience: templateAudience,
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
	item: hydratedTemplateItem,
	...watermark
});
const missing = v.object({ status: v.literal('missing'), ...watermark });
async function observation(ctx: QueryCtx, company: Doc<'company'>) {
	const pointer = await currentPointer(ctx, company._id);
	const [templateSource, version, certificate] = await Promise.all([
		company.templateSourceId ? ctx.db.get('templateSources', company.templateSourceId) : null,
		pointer ? ctx.db.get('templateVersions', pointer.versionId) : null,
		company.templateSourceId
			? readValidationCertificate(ctx, company._id, company.templateSourceId)
			: null
	]);
	const ready = Boolean(
		templateSource &&
		version &&
		templateSource.companyId === company._id &&
		version.companyId === company._id &&
		templateSource._id === version.templateSourceId &&
		templateSource.blockCount === version.blockCount &&
		templateSource.state === 'active' &&
		validationCertified(templateSource, certificate, version)
	);
	return {
		version,
		ready,
		watermark: {
			templateSourceId: templateSource?._id ?? null,
			templateSourceFingerprint: templateSource?.fingerprint ?? '',
			...templateGenerations(version)
		}
	};
}
async function committed(ctx: QueryCtx, company: Doc<'company'>) {
	const pointer = await currentPointer(ctx, company._id);
	const [templateSource, version] = await Promise.all([
		company.templateSourceId ? ctx.db.get('templateSources', company.templateSourceId) : null,
		pointer ? ctx.db.get('templateVersions', pointer.versionId) : null
	]);
	return {
		templateSourceId: templateSource?._id ?? null,
		templateSourceFingerprint: templateSource?.fingerprint ?? '',
		...templateGenerations(version)
	};
}
function rejection(error: unknown) {
	if (!(error instanceof PlaybookValidationError)) throw error;
	return { status: 'rejected' as const, message: error.message };
}
/** Build buckets from certified structure, then validate only the changed relationships. */
async function validateStructure(
	ctx: QueryCtx,
	captured: Awaited<ReturnType<typeof readAuthoringVersion>>,
	item: TemplateItem,
	previous?: TemplateDetailRecord
) {
	const { templateSource, version } = captured;
	if (
		version.headReadBytes +
			captured.certificate.readBytes +
			documentBytes(captured.certificate) +
			documentBytes(version) +
			documentBytes(templateSource) +
			2_100_000 >
		16 * 1024 * 1024
	)
		throw templateRejected('Template structure exceeds supported read capacity.');
	const [contract, heads] = await Promise.all([
		readValidationFacts(ctx, templateSource, captured.certificate),
		ctx.db
			.query('playbookItems')
			.withIndex('by_companyId_and_audience', (q) =>
				q.eq('companyId', version.companyId).eq('audience', item.audience)
			)
			.take(MAX_PLAYBOOK_ITEMS + 1)
	]);
	const ordered = orderedAudienceHeads(version, item.audience, heads);
	const geometry = new PlaybookGeometryIndex(contract);
	geometry.loadCertified(ordered.map((head) => [head._id, headStructure(head)] as const));
	if (item.audience === 'rep') validateChangeReferences(contract, item);
	geometry.validateTriggersReplacing(previous?._id, [item.trigger]);
	for (const concession of playbookStructure(item).concessions)
		geometry.validateChanges(concession.changes, previous?._id, [item.trigger]);
}
/** All ordinary authoring uses one metadata/delta writer; no template source prose or snapshot serialization. */
export const saveTemplateItem = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.optional(v.id('playbookItems')),
		item: templateItem,
		expectedContentRevision: v.number(),
		operationId: v.string()
	},
	returns: v.union(
		v.object({ status: v.literal('saved'), item: hydratedTemplateItem, ...watermark }),
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
				if (!head || head.companyId !== access.companyId)
					return { status: 'missing' as const, ...(await committed(ctx, access.company)) };
				if (head.audience !== item.audience)
					return {
						status: 'rejected' as const,
						message: 'The template item audience cannot change.'
					};
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
		} else if (!head || head.companyId !== access.companyId)
			return { status: 'missing' as const, ...(await committed(ctx, access.company)) };
		if (head && head.audience !== item.audience)
			return { status: 'rejected' as const, message: 'The template item audience cannot change.' };
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
		if (!current && expectedContentRevision !== 0)
			return { status: 'missing' as const, ...(await committed(ctx, access.company)) };
		try {
			validateTemplateItemContent(item);
			if (current?.audience === 'rep' && item.audience === 'rep')
				validateConcessionUpdate(current, item);
		} catch (error) {
			return rejection(error);
		}
		let captured = await readAuthoringVersion(ctx, access.company, current ?? undefined);
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
		if (!isMutableTemplateVersion(captured.version)) {
			const { _id, _creationTime, ...version } = captured.version;
			const versionId = await ctx.db.insert('templateVersions', {
				...version,
				mutability: 'mutable'
			});
			const pointer = { ...captured.pointer, versionId };
			await ctx.db.patch('currentTemplate', pointer._id, { versionId });
			captured = {
				...captured,
				pointer,
				version: { ...captured.version, _id: versionId, mutability: 'mutable' }
			};
		}
		const mutableVersionId = captured.version._id;
		let next: TemplateDetailRecord;
		let previousRevision: Doc<'playbookItemRevisions'> | null = null;
		let nextRevisionBytes: number;
		if (!current) {
			next = await createAuthoringItem(ctx, {
				...item,
				companyId: access.companyId,
				renderKey: operationId,
				lastOperation: { id: operationId, callerId: access.profile._id },
				mutableVersionId,
				knownVersion: captured.version
			});
			const receipt = {
				companyId: access.companyId,
				renderKey: operationId,
				operationId: scopedOperation(access, operationId),
				itemId: next._id
			};
			await ctx.db.insert('playbookItemCreationReceipts', receipt);
			nextRevisionBytes = documentBytes({
				...itemRevision(next),
				mutableVersionId,
				_id: next.currentRevisionId,
				_creationTime: 0
			});
		} else {
			previousRevision = currentRevision;
			if (!previousRevision) throw templateRejected('The saved rule revision is missing.');
			const proposed: UnrevisedDetailRecord = {
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
					? await replaceDraftItemRevision(
							ctx,
							previousRevision._id,
							proposed,
							mutableVersionId,
							captured.version,
							previousRevision
						)
					: await storeItemRevision(ctx, proposed, mutableVersionId, captured.version);
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
			await ctx.db.replace('playbookItems', current._id, packedHead);
		}
		await saveChangedVersion(
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
		const hasRepInstructions =
			captured.version.items.some((reference) => reference.audience === 'rep') ||
			next.audience === 'rep';
		if (hasRepInstructions !== access.company.hasRepInstructions)
			await ctx.db.patch('company', access.companyId, { hasRepInstructions });
		return {
			status: 'saved' as const,
			item: next,
			templateSourceId: captured.templateSource._id,
			templateSourceFingerprint: captured.templateSource.fingerprint,
			...nextTemplateGenerations(captured.version, structuralChanged)
		};
	}
});
export const deleteTemplateItem = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('playbookItems'),
		audience: templateAudience,
		expectedContentRevision: v.number()
	},
	returns: v.union(v.object({ status: v.literal('deleted'), ...watermark }), conflict),
	handler: async (ctx, { membershipId, id, expectedContentRevision, audience }) => {
		const access = await requirePermission(ctx, 'manageTemplate', membershipId);
		const head = await ctx.db.get('playbookItems', id);
		if (head && (head.companyId !== access.companyId || head.audience !== audience))
			throw new Error('This item is unavailable.');
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
		const hasRepInstructions = captured.version.items.some(
			(reference) => reference.itemId !== id && reference.audience === 'rep'
		);
		if (hasRepInstructions !== access.company.hasRepInstructions)
			await ctx.db.patch('company', access.companyId, { hasRepInstructions });
		return {
			status: 'deleted' as const,
			templateSourceId: captured.templateSource._id,
			templateSourceFingerprint: captured.templateSource.fingerprint,
			...nextTemplateGenerations(captured.version, true)
		};
	}
});
export const currentStructure = query({
	args: { audience: templateAudience },
	returns: v.object({ ...watermark, ready: v.boolean(), items: v.array(structureItem) }),
	handler: async (ctx, { audience }) => {
		const access =
				audience === 'buyer'
					? await requirePermission(ctx, 'manageTemplate')
					: await requireMembership(ctx),
			state = await observation(ctx, access.company);
		if (!state.ready) return { ...state.watermark, ready: false, items: [] };
		const heads = await ctx.db
			.query('playbookItems')
			.withIndex('by_companyId_and_audience', (q) =>
				q.eq('companyId', access.companyId).eq('audience', audience)
			)
			.take(MAX_PLAYBOOK_ITEMS + 1);
		const ordered = orderedAudienceHeads(state.version!, audience, heads);
		return {
			...state.watermark,
			ready: true,
			items: ordered.map((head) => ({
				_id: head._id,
				_creationTime: head._creationTime,
				companyId: head.companyId,
				contentRevision: head.contentRevision,
				renderKey: head.renderKey,
				...headStructure(head)
			}))
		};
	}
});
const itemContent = v.union(
	v.object({
		...sourceIdentity,
		ready: v.boolean(),
		status: v.literal('present'),
		item: hydratedTemplateItem
	}),
	v.object({ ...sourceIdentity, ready: v.boolean(), status: v.literal('missing') })
);
/** One authorization and source certification for a bounded batch of immutable revisions. */
export const batchContent = query({
	args: { ids: v.array(v.id('playbookItems')), audience: templateAudience },
	returns: v.array(v.object({ id: v.id('playbookItems'), content: itemContent })),
	handler: async (ctx, { ids, audience }) => {
		if (ids.length > 64) throw new ConvexError('Request at most 64 template items.');
		const access =
			audience === 'buyer'
				? await requirePermission(ctx, 'manageTemplate')
				: await requireMembership(ctx);
		const unique = [...new Set(ids)];
		const [source, certificate, heads] = await Promise.all([
			access.company.templateSourceId
				? ctx.db.get('templateSources', access.company.templateSourceId)
				: null,
			access.company.templateSourceId
				? readValidationCertificate(ctx, access.companyId, access.company.templateSourceId)
				: null,
			Promise.all(unique.map((id) => ctx.db.get('playbookItems', id)))
		]);
		const scope = {
			templateSourceId: source?._id ?? null,
			templateSourceFingerprint: source?.fingerprint ?? '',
			ready: Boolean(
				source?.companyId === access.companyId &&
				source.state === 'active' &&
				validationCertified(source, certificate)
			)
		};
		return Promise.all(
			unique.map(async (id, index) => {
				const head = heads[index];
				if (
					!scope.ready ||
					!head ||
					head.companyId !== access.companyId ||
					head.audience !== audience
				)
					return { id, content: { ...scope, status: 'missing' as const } };
				return {
					id,
					content: { ...scope, status: 'present' as const, item: await hydrateHead(ctx, head) }
				};
			})
		);
	}
});
