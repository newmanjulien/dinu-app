import { makeFunctionReference } from 'convex/server';
import { ConvexError, v, type Infer } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { NativeOwner, ConstructionSnapshot } from './nativeConstruction';
import type { storedContractChange } from './contractChangeValidators';
import { decodeContractDocumentChunks, planContractDocumentChunks } from './contractDocuments';
import { receiptChunkFingerprint } from './operationReceipts';
import { canonicalJson } from '../lib/document/canonical-json';
import {
	applyDocumentChange,
	reverseDocumentChange,
	prepareDocumentChange,
	captureDocumentDifference,
	DocumentChangeConflict,
	type ContractDocument,
	type DocumentChange
} from '../lib/document/contract-document';
import { discussionTape, discussionTransition } from '../lib/discussions/tape';
import { DISCUSSION_MAP_CHUNK_SPLICES, discussionMapManifest } from './discussionMaps';

type Kind =
	'source' | 'current' | 'base' | 'candidate' | 'comparison' | 'predecessor' | 'patch' | 'other';
const snapshot = makeFunctionReference<'query', NativeOwner, string | null>(
	'nativeConstruction:snapshot'
);
const artifact = makeFunctionReference<
	'query',
	NativeOwner & { kind: Kind },
	Doc<'contractDocuments'> | Doc<'contractChanges'> | null
>('nativeConstruction:artifact');
const artifactPage = makeFunctionReference<
	'query',
	NativeOwner & { kind: Kind; offset: number },
	Doc<'contractDocumentChunks'>[] | Doc<'contractChangeContents'>[] | null
>('nativeConstruction:artifactPage');
const checkpoint = makeFunctionReference<
	'mutation',
	NativeOwner & {
		value:
			| { kind: 'start' | 'finish' | 'compared-own' }
			| { kind: 'reversed'; documentId: Id<'contractDocuments'> }
			| { kind: 'patched'; documentId: Id<'contractDocuments'>; changeId: Id<'contractChanges'> }
			| { kind: 'compared'; incompatible: boolean; documentId?: Id<'contractDocuments'> };
	},
	null
>('nativeConstruction:checkpoint');
const beginDocument = makeFunctionReference<
	'mutation',
	NativeOwner & {
		slot: 'reverse' | 'candidate' | 'comparison';
		fingerprint: string;
		hashes: string[];
		dataBytes: number;
		blockCount: number;
	},
	Doc<'contractDocuments'> | null
>('nativeConstructionStorage:beginDocument');
const appendDocument = makeFunctionReference<
	'mutation',
	NativeOwner & { documentId: Id<'contractDocuments'>; offset: number; chunks: ArrayBuffer[] },
	boolean
>('nativeConstructionStorage:appendDocument');
const beginChange = makeFunctionReference<
	'mutation',
	NativeOwner & { row: Infer<typeof storedContractChange>; hashes: string[] },
	Doc<'contractChanges'> | null
>('nativeConstructionStorage:beginChange');
const appendChange = makeFunctionReference<
	'mutation',
	NativeOwner & { changeId: Id<'contractChanges'>; offset: number; parts: string[] },
	boolean
>('nativeConstructionStorage:appendChange');
const geometry = makeFunctionReference<
	'mutation',
	NativeOwner & {
		manifest: ReturnType<typeof discussionMapManifest>;
		offset: number;
		total: number;
		splices: ReturnType<typeof discussionTransition>['splices'];
		done: boolean;
	},
	boolean
>('nativeConstruction:geometry');
const fail = makeFunctionReference<'mutation', NativeOwner & { error: string }, null>(
	'nativePlanPreparation:failSource'
);
export class ObsoleteNativeUnit extends Error {}
export async function nativeDocument(
	ctx: ActionCtx,
	owner: NativeOwner,
	kind: Kind
): Promise<ContractDocument> {
	const manifest = await ctx.runQuery(artifact, { ...owner, kind });
	if (!manifest) throw new ObsoleteNativeUnit();
	if (!('chunkIds' in manifest)) throw new Error('Native document artifact kind changed.');
	const rows: Doc<'contractDocumentChunks'>[] = [];
	for (let offset = 0; offset < manifest.chunkIds.length; offset += 4) {
		const page = await ctx.runQuery(artifactPage, { ...owner, kind, offset });
		if (!page) throw new ObsoleteNativeUnit();
		rows.push(...(page as Doc<'contractDocumentChunks'>[]));
	}
	return decodeContractDocumentChunks(manifest, rows);
}
export async function nativePatch(
	ctx: ActionCtx,
	owner: NativeOwner,
	kind: Kind
): Promise<{ row: Doc<'contractChanges'>; patch: DocumentChange }> {
	const row = await ctx.runQuery(artifact, { ...owner, kind });
	if (!row) throw new ObsoleteNativeUnit();
	if (!('patchKey' in row) || row.chunks < 1 || row.chunks > 64 || row.dataBytes > 8_000_000)
		throw new Error('Invalid native patch artifact.');
	const parts: string[] = [];
	for (let offset = 0; offset < row.chunks; offset += 4) {
		const page = await ctx.runQuery(artifactPage, { ...owner, kind, offset });
		if (!page) throw new ObsoleteNativeUnit();
		parts.push(...(page as Doc<'contractChangeContents'>[]).map((part) => part.data));
	}
	const data = parts.join(''),
		value = JSON.parse(data) as DocumentChange;
	if (
		new TextEncoder().encode(data).length !== row.dataBytes ||
		value.id !== row.patchKey ||
		!Array.isArray(value.parts) ||
		!Array.isArray(value.dependencies)
	)
		throw new Error('Native patch integrity failed.');
	return { row, patch: value };
}
export async function uploadNativeDocument(
	ctx: ActionCtx,
	owner: NativeOwner,
	slot: 'reverse' | 'candidate' | 'comparison',
	value: ContractDocument
) {
	const chunks = planContractDocumentChunks(value),
		hashes = chunks.map((chunk) => chunk.fingerprint);
	const row = await ctx.runMutation(beginDocument, {
		...owner,
		slot,
		fingerprint: receiptChunkFingerprint(JSON.stringify(hashes)),
		hashes,
		dataBytes: chunks.reduce((n, c) => n + c.data.byteLength, 0),
		blockCount: value.blocks.length
	});
	if (!row) throw new ObsoleteNativeUnit();
	for (let offset = row.stage!.written; offset < chunks.length; offset += 4)
		if (
			!(await ctx.runMutation(appendDocument, {
				...owner,
				documentId: row._id,
				offset,
				chunks: chunks.slice(offset, offset + 4).map((chunk) => chunk.data)
			}))
		)
			throw new ObsoleteNativeUnit();
	return row._id;
}
export async function uploadNativePatch(
	ctx: ActionCtx,
	owner: NativeOwner,
	fields: Omit<Infer<typeof storedContractChange>, 'chunks' | 'dataBytes'>,
	value: DocumentChange
) {
	const data = JSON.stringify(value),
		parts: string[] = [];
	for (let offset = 0; offset < data.length;) {
		let end = Math.min(offset + 120 * 1024, data.length);
		if (
			data.charCodeAt(end - 1) >= 0xd800 &&
			data.charCodeAt(end - 1) <= 0xdbff &&
			data.charCodeAt(end) >= 0xdc00 &&
			data.charCodeAt(end) <= 0xdfff
		)
			end++;
		parts.push(data.slice(offset, end));
		offset = end;
	}
	const bytes = new TextEncoder().encode(data).length;
	if (bytes > 8_000_000 || parts.length > 64)
		throw new ConvexError('This change exceeds supported document capacity.');
	const row = { ...fields, chunks: parts.length, dataBytes: bytes } as Infer<
		typeof storedContractChange
	>;
	const stored = await ctx.runMutation(beginChange, {
		...owner,
		row,
		hashes: parts.map(receiptChunkFingerprint)
	});
	if (!stored) throw new ObsoleteNativeUnit();
	for (let offset = stored.stage!.written; offset < parts.length; offset += 4)
		if (
			!(await ctx.runMutation(appendChange, {
				...owner,
				changeId: stored._id,
				offset,
				parts: parts.slice(offset, offset + 4)
			}))
		)
			throw new ObsoleteNativeUnit();
	return stored._id;
}
async function uploadPatch(
	ctx: ActionCtx,
	owner: NativeOwner,
	s: ConstructionSnapshot,
	value: DocumentChange
) {
	if (!s.command || !s.commandKey || !s.source)
		throw new Error('Native patch has no exact command source.');
	const manifest = await ctx.runQuery(artifact, { ...owner, kind: 'source' });
	if (!manifest) throw new ObsoleteNativeUnit();
	const row = {
		companyId: manifest.companyId,
		contractId: manifest.contractId,
		key: s.command.itemId,
		operationId: s.commandKey,
		patchKey: s.commandKey,
		actor: s.actor,
		createdAt: s.createdAt,
		...(s.target?.applied ? { predecessorId: s.target.applied._id } : {}),
		policy: s.policy,
		kind: 'playbook' as const,
		source: s.source
	};
	return uploadNativePatch(ctx, owner, row, value);
}
/** A unit holds a constant number of document values and one immutable patch.
 * Every uploaded page and phase checkpoint is independently durable and owned. */
export const construct = internalAction({
	args: { receiptId: v.id('operationReceipts'), generation: v.number(), unit: v.number() },
	returns: v.null(),
	handler: async (ctx, owner) => {
		try {
			const encoded = await ctx.runQuery(snapshot, owner);
			if (!encoded) return null;
			const s = JSON.parse(encoded) as ConstructionSnapshot,
				b = s.build;
			if (b.phase === 'command') {
				await ctx.runMutation(checkpoint, { ...owner, value: { kind: 'start' } });
			} else if (b.phase === 'reverse') {
				const base = await nativeDocument(ctx, owner, 'base'),
					previous = await nativePatch(ctx, owner, 'predecessor');
				const documentId = await uploadNativeDocument(
					ctx,
					owner,
					'reverse',
					reverseDocumentChange(base, previous.patch)
				);
				await ctx.runMutation(checkpoint, { ...owner, value: { kind: 'reversed', documentId } });
			} else if (b.phase === 'patch') {
				const current = await nativeDocument(ctx, owner, 'current'),
					base = await nativeDocument(ctx, owner, 'base');
				const final = s.changes.length
					? applyDocumentChange(base, prepareDocumentChange(base, s.changes, s.commandKey!))
					: base;
				const change = captureDocumentDifference(current, final, s.commandKey!);
				change.annotationKind = 'playbook';
				const applied = applyDocumentChange(current, change);
				if (canonicalJson(applied.blocks) !== canonicalJson(final.blocks))
					throw new DocumentChangeConflict('The wording transition could not be applied exactly.');
				const changeId = await uploadPatch(ctx, owner, s, change),
					documentId = await uploadNativeDocument(ctx, owner, 'candidate', applied);
				await ctx.runMutation(checkpoint, {
					...owner,
					value: { kind: 'patched', changeId, documentId }
				});
			} else if (b.phase === 'compare') {
				const other = s.scan;
				if (
					!other ||
					other.key === s.target?.key ||
					!other.current ||
					other.current._id === other.applied?._id ||
					other.current.policy === 'none' ||
					other.currentDecision?.status === 'approved'
				) {
					await ctx.runMutation(checkpoint, {
						...owner,
						value: { kind: 'compared', incompatible: false }
					});
				} else {
					const candidate = await nativeDocument(ctx, owner, 'candidate'),
						otherPatch = await nativePatch(ctx, owner, 'other');
					let incompatible = false,
						documentId: Id<'contractDocuments'> | undefined;
					try {
						applyDocumentChange(candidate, otherPatch.patch);
						if (!s.approve) {
							const current = await nativeDocument(ctx, owner, 'current');
							documentId = await uploadNativeDocument(
								ctx,
								owner,
								'comparison',
								applyDocumentChange(current, otherPatch.patch)
							);
						}
					} catch (error) {
						if (!(error instanceof DocumentChangeConflict)) throw error;
						incompatible = true;
					}
					await ctx.runMutation(checkpoint, {
						...owner,
						value: { kind: 'compared', incompatible, ...(documentId ? { documentId } : {}) }
					});
				}
			} else if (b.phase === 'compare-own') {
				applyDocumentChange(
					await nativeDocument(ctx, owner, 'comparison'),
					(await nativePatch(ctx, owner, 'patch')).patch
				);
				await ctx.runMutation(checkpoint, { ...owner, value: { kind: 'compared-own' } });
			} else if (b.phase === 'finish')
				await ctx.runMutation(checkpoint, { ...owner, value: { kind: 'finish' } });
			else if (b.phase === 'geometry') {
				await uploadNativeGeometry(ctx, owner, b);
			}
		} catch (error) {
			if (error instanceof ObsoleteNativeUnit) return null;
			const message =
				error instanceof ConvexError && typeof error.data === 'string'
					? error.data
					: error instanceof Error
						? error.message
						: 'This native operation could not complete.';
			await ctx.runMutation(fail, { ...owner, error: message.slice(0, 2000) });
		}
		return null;
	}
});

export async function uploadNativeGeometry(
	ctx: ActionCtx,
	owner: NativeOwner,
	b: ConstructionSnapshot['build']
) {
	const map = discussionTransition(
			discussionTape(await nativeDocument(ctx, owner, 'source')),
			discussionTape(await nativeDocument(ctx, owner, 'current'))
		),
		manifest = discussionMapManifest(map, b.identity);
	if (manifest.inline || !map.splices.length) {
		await ctx.runMutation(geometry, {
			...owner,
			manifest,
			offset: 0,
			total: map.splices.length,
			splices: [],
			done: true
		});
	} else {
		let offset = 0;
		while (offset < map.splices.length) {
			const page = map.splices.slice(offset, offset + DISCUSSION_MAP_CHUNK_SPLICES);
			const done = offset + page.length === map.splices.length;
			if (
				!(await ctx.runMutation(geometry, {
					...owner,
					manifest,
					offset,
					total: map.splices.length,
					splices: page,
					done
				}))
			)
				throw new ObsoleteNativeUnit();
			offset += page.length;
		}
	}
}
