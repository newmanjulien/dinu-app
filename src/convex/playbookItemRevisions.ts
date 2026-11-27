import { ConvexError, type Infer } from 'convex/values';
import type { TemplateItem } from '../lib/playbook/model';
import type { TemplateDetailRecord } from '../lib/playbook/structure';
import { playbookStructure } from '../lib/playbook/structure';
import { decodeStructure, encodeStructure } from '../lib/playbook/structure-codec';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { historicalItem } from './playbookValidators';

export type HistoricalItem = Infer<typeof historicalItem>;
export type UnrevisedDetailRecord = HistoricalItem &
	Pick<TemplateDetailRecord, 'renderKey'> &
	Partial<Pick<TemplateDetailRecord, 'lastOperation'>>;

/** Re-read the authoritative owner at every mutable-body write boundary. */
async function currentMutableVersion(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	versionId: Id<'templateVersions'>
) {
	const [pointer, version] = await Promise.all([
		ctx.db
			.query('currentTemplate')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.unique(),
		ctx.db.get('templateVersions', versionId)
	]);
	if (
		!pointer ||
		pointer.versionId !== versionId ||
		!version ||
		version.companyId !== companyId ||
		version.mutability !== 'mutable'
	)
		throw new ConvexError('This template revision is no longer mutable.');
	return version;
}

/** Project the business fields without persistence metadata. */
export function businessItem(item: TemplateItem): TemplateItem {
	if (item.audience === 'buyer')
		return { audience: item.audience, trigger: item.trigger, explanation: item.explanation };
	const { trigger, instructions, concessions, approvalPolicy } = item;
	return {
		audience: 'rep',
		approvalPolicy,
		trigger,
		instructions,
		concessions
	};
}
export function snapshotItem(item: HistoricalItem): HistoricalItem {
	return {
		...businessItem(item),
		_id: item._id,
		_creationTime: item._creationTime,
		companyId: item.companyId,
		contentRevision: item.contentRevision
	};
}
export function itemRevision(saved: UnrevisedDetailRecord) {
	return {
		companyId: saved.companyId,
		itemId: saved._id,
		itemCreatedAt: saved._creationTime,
		contentRevision: saved.contentRevision,
		body: businessItem(saved),
		...(saved.lastOperation ? { lastOperation: saved.lastOperation } : {}),
		renderKey: saved.renderKey
	};
}
export function historicalRevision(saved: Doc<'playbookItemRevisions'>): HistoricalItem {
	return {
		...businessItem(saved.body),
		_id: saved.itemId,
		_creationTime: saved.itemCreatedAt,
		companyId: saved.companyId,
		contentRevision: saved.contentRevision
	};
}
export async function storeItemRevision(
	ctx: MutationCtx,
	saved: UnrevisedDetailRecord,
	mutableVersionId?: Id<'templateVersions'>,
	knownVersion?: Doc<'templateVersions'>
) {
	if (mutableVersionId && !knownVersion)
		await currentMutableVersion(ctx, saved.companyId, mutableVersionId);
	const contentRevision = { ...itemRevision(saved), mutableVersionId };
	return ctx.db.insert('playbookItemRevisions', contentRevision);
}

/** A mutable revision can be replaced because no saved contract can reference it. */
export async function replaceDraftItemRevision(
	ctx: MutationCtx,
	revisionId: Id<'playbookItemRevisions'>,
	saved: UnrevisedDetailRecord,
	mutableVersionId: Id<'templateVersions'>,
	knownVersion?: Doc<'templateVersions'>,
	knownPrevious?: Doc<'playbookItemRevisions'>
) {
	const [version, previous] = await Promise.all([
		knownVersion ?? currentMutableVersion(ctx, saved.companyId, mutableVersionId),
		knownPrevious ?? ctx.db.get('playbookItemRevisions', revisionId)
	]);
	if (
		!previous ||
		previous.companyId !== saved.companyId ||
		previous.itemId !== saved._id ||
		previous.mutableVersionId !== mutableVersionId ||
		previous.itemCreatedAt !== saved._creationTime ||
		saved.contentRevision !== previous.contentRevision + 1 ||
		!version.items.some((item) => item.itemId === saved._id && item.revisionId === revisionId)
	)
		throw new ConvexError('This template revision cannot be replaced.');
	const contentRevision = { ...itemRevision(saved), mutableVersionId };
	await ctx.db.replace('playbookItemRevisions', revisionId, contentRevision);
	return revisionId;
}

/** Compact heads are the only live storage format written by canonical writers. */
export function compactHead(saved: TemplateDetailRecord) {
	return {
		format: 1 as const,
		companyId: saved.companyId,
		audience: saved.audience,
		contentRevision: saved.contentRevision,
		currentRevisionId: saved.currentRevisionId,
		...(saved.lastOperation ? { lastOperation: saved.lastOperation } : {}),
		renderKey: saved.renderKey,
		structure: encodeStructure(playbookStructure(saved))
	};
}
export function headStructure(head: Doc<'playbookItems'>) {
	const structure = decodeStructure(head.structure);
	if (structure.audience !== head.audience)
		throw new Error('The stored template item audience does not match its structure.');
	return structure;
}
export function liveRevision(revision: Doc<'playbookItemRevisions'>): TemplateDetailRecord {
	return {
		...historicalRevision(revision),
		currentRevisionId: revision._id,
		...(revision.lastOperation ? { lastOperation: revision.lastOperation } : {}),
		renderKey: revision.renderKey
	};
}
export async function hydrateHead(
	ctx: QueryCtx,
	head: Doc<'playbookItems'>,
	knownRevision?: Doc<'playbookItemRevisions'> | null
): Promise<TemplateDetailRecord> {
	const revision =
		knownRevision === undefined
			? head.currentRevisionId
				? await ctx.db.get('playbookItemRevisions', head.currentRevisionId)
				: null
			: knownRevision;
	if (
		!revision ||
		revision.companyId !== head.companyId ||
		revision.itemId !== head._id ||
		revision.itemCreatedAt !== head._creationTime ||
		revision.contentRevision !== head.contentRevision ||
		revision.body.audience !== head.audience
	)
		throw new Error('The saved rule revision is missing.');
	return {
		...liveRevision(revision),
		...(head.lastOperation ? { lastOperation: head.lastOperation } : {}),
		renderKey: head.renderKey
	};
}
/** Allocate identity cheaply; publish the complete packed head once in the same transaction. */
export async function createAuthoringItem(
	ctx: MutationCtx,
	content: TemplateItem & {
		companyId: Id<'company'>;
		lastOperation?: TemplateDetailRecord['lastOperation'];
		renderKey?: string;
		mutableVersionId?: Id<'templateVersions'>;
		knownVersion?: Doc<'templateVersions'>;
	}
): Promise<TemplateDetailRecord> {
	const initial = {
		format: 1 as const,
		companyId: content.companyId,
		audience: content.audience,
		contentRevision: 1,
		...(content.lastOperation ? { lastOperation: content.lastOperation } : {}),
		renderKey: content.renderKey ?? content.lastOperation?.id ?? '',
		structure: new ArrayBuffer(0)
	};
	const id = await ctx.db.insert('playbookItems', initial);
	const head = (await ctx.db.get('playbookItems', id))!;
	const saved: UnrevisedDetailRecord = {
		...businessItem(content),
		_id: id,
		_creationTime: head._creationTime,
		companyId: content.companyId,
		contentRevision: 1,
		...(content.lastOperation ? { lastOperation: content.lastOperation } : {}),
		renderKey: initial.renderKey || id
	};
	const currentRevisionId = await storeItemRevision(
		ctx,
		saved,
		content.mutableVersionId,
		content.knownVersion
	);
	const next: TemplateDetailRecord = { ...saved, currentRevisionId };
	const packedHead = compactHead(next);
	await ctx.db.replace('playbookItems', id, packedHead);
	return next;
}
