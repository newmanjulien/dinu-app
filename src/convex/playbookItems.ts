import { templateAudience, templateItem } from '../lib/playbook/validators';
import { containsRange } from '../lib/document/ranges';
import { v } from 'convex/values';
import { sourceTarget } from '../lib/document/source-validators';
import { PlaybookGeometryIndex } from '../lib/playbook/geometry-index';
import { MAX_PLAYBOOK_ITEMS } from '../lib/playbook/limits';
import type { TemplateItem } from '../lib/playbook/model';
import { playbookStructure, type TemplateDetailRecord } from '../lib/playbook/structure';
import { equalItemStructure } from '../lib/playbook/structure-codec';
import {
	validateChangeReferences,
	validateConcessionUpdate,
	validateTemplateItemContent,
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
import { hydratedTemplateItem, trigger } from './playbookValidators';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { templateRejected } from './templateCapacity';
import {
	addTemplateReadBytes,
	orderedHeads,
	currentPointer,
	isMutableTemplateVersion,
	readAuthoringVersion,
	templateGenerations,
	saveChangedVersion
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
		!company.authoringMigration &&
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
		pointer,
		templateSource,
		version,
		ready,
		templateSourceFingerprint: templateSource?.fingerprint ?? '',
		...templateGenerations(version, pointer)
	};
}
function observed({
	templateSource,
	templateSourceFingerprint,
	authoringGeneration,
	structuralGeneration
}: Awaited<ReturnType<typeof observation>>) {
	return {
		templateSourceId: templateSource?._id ?? null,
		templateSourceFingerprint,
		authoringGeneration,
		structuralGeneration
	};
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
	item: TemplateItem,
	previous?: TemplateDetailRecord
) {
	const { templateSource, version } = captured;
	if (
		(version.headReadBytes ?? 0) +
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
			.withIndex('by_companyId', (q) => q.eq('companyId', version.companyId))
			.take(MAX_PLAYBOOK_ITEMS + 1)
	]);
	const ordered = orderedHeads(version, heads);
	const geometry = new PlaybookGeometryIndex(contract);
	geometry.loadCertified(
		ordered
			.map((head) => [head._id, headStructure(head)] as const)
			.filter(([, structure]) => structure.audience === item.audience)
	);
	if (item.audience === 'rep') {
		validateStructuralReplacementContent(item);
		validateChangeReferences(contract, item);
	}
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
				if (headStructure(head).audience !== item.audience)
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
		const currentRevision = head?.currentRevisionId
			? await ctx.db.get('playbookItemRevisions', head.currentRevisionId)
			: null;
		const current = head ? await hydrateHead(ctx, head, currentRevision) : null;
		if (current && current.audience !== item.audience)
			return { status: 'rejected' as const, message: 'The template item audience cannot change.' };

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
		let next: TemplateDetailRecord;
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
			const proposed: TemplateDetailRecord = {
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
			await addTemplateReadBytes(ctx, versionId, captured.templateSource, delta);
		}
		return { status: 'saved' as const, item: next, ...(await committed(ctx, access.company)) };
	}
});
export const deleteTemplateItem = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('playbookItems'),
		audience: v.optional(templateAudience),
		expectedContentRevision: v.number()
	},
	returns: v.union(v.object({ status: v.literal('deleted'), ...watermark }), conflict),
	handler: async (ctx, { membershipId, id, expectedContentRevision, audience = 'rep' }) => {
		const access = await requirePermission(ctx, 'manageTemplate', membershipId);
		const head = await ctx.db.get('playbookItems', id);
		if (head && (head.companyId !== access.companyId || headStructure(head).audience !== audience))
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
	args: { membershipId: v.id('memberships'), audience: v.optional(templateAudience) },
	returns: v.object({ ...watermark, ready: v.boolean(), items: v.array(structureItem) }),
	handler: async (ctx, { membershipId, audience = 'rep' }) => {
		const access =
				audience === 'buyer'
					? await requirePermission(ctx, 'manageTemplate', membershipId)
					: await requireMembership(ctx, membershipId),
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
			items: ordered
				.filter((head) => headStructure(head).audience === audience)
				.map((head) => ({
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
/** Item bodies do not depend on the global pointer, manifest or authoring generation. */
export const content = query({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('playbookItems'),
		audience: v.optional(templateAudience)
	},
	returns: v.union(
		v.object({
			...sourceIdentity,
			ready: v.boolean(),
			status: v.literal('present'),
			item: hydratedTemplateItem
		}),
		v.object({ ...sourceIdentity, ready: v.boolean(), status: v.literal('missing') })
	),
	handler: async (ctx, { membershipId, id, audience = 'rep' }) => {
		const access =
			audience === 'buyer'
				? await requirePermission(ctx, 'manageTemplate', membershipId)
				: await requireMembership(ctx, membershipId);
		const [source, certificate, head] = await Promise.all([
			access.company.templateSourceId
				? ctx.db.get('templateSources', access.company.templateSourceId)
				: null,
			access.company.templateSourceId
				? readValidationCertificate(ctx, access.companyId, access.company.templateSourceId)
				: null,
			ctx.db.get('playbookItems', id)
		]);
		const scope = {
			templateSourceId: source?._id ?? null,
			templateSourceFingerprint: source?.fingerprint ?? '',
			ready: Boolean(
				!access.company.authoringMigration &&
				source?.companyId === access.companyId &&
				source.state === 'active' &&
				validationCertified(source, certificate)
			)
		};
		if (
			!scope.ready ||
			!head ||
			head.companyId !== access.companyId ||
			headStructure(head).audience !== audience
		)
			return { ...scope, status: 'missing' as const };
		return { ...scope, status: 'present' as const, item: await hydrateHead(ctx, head) };
	}
});

/** Only admins may copy saved rep wording into an independent buyer draft. */
export const repSummary = query({
	args: {
		membershipId: v.id('memberships'),
		templateSourceFingerprint: v.string(),
		target: sourceTarget
	},
	returns: v.union(v.null(), v.string()),
	handler: async (ctx, { membershipId, templateSourceFingerprint, target }) => {
		const access = await requirePermission(ctx, 'manageTemplate', membershipId);
		const state = await observation(ctx, access.company);
		if (
			!state.ready ||
			state.templateSourceFingerprint !== templateSourceFingerprint ||
			target.kind !== 'text'
		)
			return null;
		const facts = await readValidationFacts(ctx, state.templateSource!, undefined);
		const heads = orderedHeads(
			state.version!,
			await ctx.db
				.query('playbookItems')
				.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
				.take(MAX_PLAYBOOK_ITEMS + 1)
		);
		const matches = heads.filter((head) => {
			const structure = headStructure(head);
			return (
				structure.audience === 'rep' &&
				structure.trigger.target.kind === 'text' &&
				containsRange(facts.index, structure.trigger.target.range, target.range)
			);
		});
		if (matches.length !== 1) return null;
		const item = await hydrateHead(ctx, matches[0]);
		if (item.audience !== 'rep' || !item.instructions?.summary?.trim()) return null;
		return item.instructions.summary;
	}
});
