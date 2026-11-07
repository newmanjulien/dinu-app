import type { Infer } from 'convex/values';
import type { PlaybookItem } from '../lib/playbook/model';
import type { DetailRecord } from '../lib/playbook/structure';
import { playbookStructure } from '../lib/playbook/structure';
import { encodeStructure, decodeStructure } from '../lib/playbook/structure-codec';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { historicalItem } from './playbookValidators';
import { assertStorageCapacity, documentBytes } from './storageCapacity';

export type HistoricalItem = Infer<typeof historicalItem>;

/** Project the business fields without persistence metadata. */
export function businessItem(item: PlaybookItem): PlaybookItem {
	const { trigger, instructions, concessions, approvalPolicy } = item;
	return {
		approvalPolicy,
		trigger,
		...(instructions === undefined ? {} : { instructions }),
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
export function itemRevision(
	saved: HistoricalItem & Partial<Pick<DetailRecord, 'lastOperation' | 'renderKey'>>
) {
	return {
		companyId: saved.companyId,
		itemId: saved._id,
		itemCreatedAt: saved._creationTime,
		contentRevision: saved.contentRevision,
		body: businessItem(saved),
		...(saved.lastOperation ? { lastOperation: saved.lastOperation } : {}),
		...(saved.renderKey ? { renderKey: saved.renderKey } : {})
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
	saved: HistoricalItem & Partial<Pick<DetailRecord, 'lastOperation' | 'renderKey'>>,
	mutableVersionId?: Id<'templateVersions'>
) {
	const contentRevision = { ...itemRevision(saved), mutableVersionId };
	await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(contentRevision) });
	return ctx.db.insert('playbookItemRevisions', contentRevision);
}

/** A mutable revision can be replaced because no saved contract can reference it. */
export async function replaceDraftItemRevision(
	ctx: MutationCtx,
	revisionId: Id<'playbookItemRevisions'>,
	saved: HistoricalItem & Partial<Pick<DetailRecord, 'lastOperation' | 'renderKey'>>,
	mutableVersionId: Id<'templateVersions'>
) {
	const contentRevision = { ...itemRevision(saved), mutableVersionId };
	await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(contentRevision) });
	await ctx.db.replace('playbookItemRevisions', revisionId, contentRevision);
	return revisionId;
}

/** A newly allocated revision becomes mutable after its owning version is known. */
export async function markDraftItemRevision(
	ctx: MutationCtx,
	revisionId: Id<'playbookItemRevisions'>,
	mutableVersionId: Id<'templateVersions'>
) {
	const contentRevision = await ctx.db.get('playbookItemRevisions', revisionId);
	if (!contentRevision || contentRevision.mutableVersionId) return 0;
	const beforeBytes = documentBytes(contentRevision);
	const afterBytes = documentBytes({ ...contentRevision, mutableVersionId });
	await assertStorageCapacity(ctx, {
		documents: 1,
		bytes: afterBytes
	});
	await ctx.db.patch('playbookItemRevisions', revisionId, { mutableVersionId });
	return afterBytes - beforeBytes;
}

/** Compact heads are the only live storage format written by canonical writers. */
export function compactHead(saved: DetailRecord) {
	return {
		format: 1 as const,
		companyId: saved.companyId,
		contentRevision: saved.contentRevision,
		currentRevisionId: saved.currentRevisionId,
		...(saved.lastOperation ? { lastOperation: saved.lastOperation } : {}),
		renderKey: saved.renderKey,
		structure: encodeStructure(playbookStructure(saved))
	};
}
export function headStructure(head: Doc<'playbookItems'>) {
	return 'format' in head ? decodeStructure(head.structure) : playbookStructure(head);
}
export function liveRevision(revision: Doc<'playbookItemRevisions'>): DetailRecord {
	return {
		...historicalRevision(revision),
		currentRevisionId: revision._id,
		...(revision.lastOperation ? { lastOperation: revision.lastOperation } : {}),
		renderKey: revision.renderKey ?? revision.itemId
	};
}
export async function hydrateHead(
	ctx: QueryCtx,
	head: Doc<'playbookItems'>,
	knownRevision?: Doc<'playbookItemRevisions'> | null
): Promise<DetailRecord> {
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
		revision.contentRevision !== head.contentRevision
	)
		throw new Error('The saved rule revision is missing.');
	return {
		...liveRevision(revision),
		...(head.lastOperation ? { lastOperation: head.lastOperation } : {}),
		renderKey: 'format' in head ? head.renderKey : head._id
	};
}
/** Allocate identity cheaply; publish the complete packed head once in the same transaction. */
export async function createAuthoringItem(
	ctx: MutationCtx,
	content: PlaybookItem & {
		companyId: Id<'company'>;
		lastOperation?: DetailRecord['lastOperation'];
		renderKey?: string;
	}
): Promise<DetailRecord> {
	const initial = {
		format: 1 as const,
		companyId: content.companyId,
		contentRevision: 1,
		...(content.lastOperation ? { lastOperation: content.lastOperation } : {}),
		renderKey: content.renderKey ?? content.lastOperation?.id ?? '',
		structure: new ArrayBuffer(0)
	};
	await assertStorageCapacity(ctx, {
		documents: 1,
		bytes: documentBytes(initial),
		queries: 1,
		readDocuments: 1
	});
	const id = await ctx.db.insert('playbookItems', initial);
	const head = (await ctx.db.get('playbookItems', id))!;
	const saved: DetailRecord = {
		...businessItem(content),
		_id: id,
		_creationTime: head._creationTime,
		companyId: content.companyId,
		contentRevision: 1,
		...(content.lastOperation ? { lastOperation: content.lastOperation } : {}),
		renderKey: initial.renderKey || id
	};
	const currentRevisionId = await storeItemRevision(ctx, saved);
	const next = { ...saved, currentRevisionId };
	const packedHead = compactHead(next);
	await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(packedHead) });
	await ctx.db.replace('playbookItems', id, packedHead);
	return next;
}
