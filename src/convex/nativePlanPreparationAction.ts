import { makeFunctionReference } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction } from './_generated/server';
import { decodeContractDocumentChunks } from './contractDocuments';
import type { DocumentChange } from '../lib/document/contract-document';
import { canonicalJson } from '../lib/document/canonical-json';
import { receiptChunkFingerprint } from './operationReceipts';
import { withoutNativeStage } from './nativeStage';
import type { NativeSourceProof, NativeSourceSnapshot } from './nativePlanPreparation';

type Owner = { receiptId: Id<'operationReceipts'>; generation: number; unit: number };
const source = makeFunctionReference<'query', Owner, NativeSourceSnapshot>(
	'nativePlanPreparation:source'
);
const documentPage = makeFunctionReference<
	'query',
	Owner & { offset: number },
	Doc<'contractDocumentChunks'>[] | null
>('nativePlanPreparation:documentPage');
const changePage = makeFunctionReference<
	'query',
	Owner & { changeId: Id<'contractChanges'>; offset: number },
	Doc<'contractChangeContents'>[] | null
>('nativePlanPreparation:changePage');
const checkpoint = makeFunctionReference<'mutation', Owner & { proof: NativeSourceProof }, null>(
	'nativePlanPreparation:checkpointSource'
);
const fail = makeFunctionReference<'mutation', Owner & { error: string }, null>(
	'nativePlanPreparation:failSource'
);

/** One immutable document or one patch is the action unit. Queries return at most
 * four owned chunks; checkpoints carry only a small integrity manifest. No action
 * can authorize or adopt business changes, or pass a document/patch to a mutation. */
export const validateSource = internalAction({
	args: { receiptId: v.id('operationReceipts'), generation: v.number(), unit: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		try {
			const snapshot: NativeSourceSnapshot = await ctx.runQuery(source, args);
			if (!snapshot) return null;
			let proof: NativeSourceProof;
			if (snapshot.kind === 'document') {
				const manifest = snapshot.manifest;
				if (manifest.chunkIds.length > 512 || manifest.readBytes > 16 * 1024 * 1024)
					throw new Error('Native source document exceeds its supported envelope.');
				const chunks: Doc<'contractDocumentChunks'>[] = [];
				for (let offset = 0; offset < manifest.chunkIds.length; offset += 4) {
					const page: Doc<'contractDocumentChunks'>[] | null = await ctx.runQuery(documentPage, {
						...args,
						offset
					});
					if (!page) return null; // A changed source/generation belongs to restart, never a mixed seal.
					if (page.length !== Math.min(4, manifest.chunkIds.length - offset))
						throw new Error('Native source document page is incomplete.');
					chunks.push(...page);
				}
				decodeContractDocumentChunks(manifest, chunks);
				proof = {
					kind: 'document',
					documentId: manifest._id,
					fingerprint: manifest.fingerprint,
					chunks: chunks.length,
					bytes: manifest.dataBytes
				};
			} else if (snapshot.kind === 'change') {
				const row = snapshot.row;
				if (
					!Number.isSafeInteger(row.chunks) ||
					row.chunks < 1 ||
					row.chunks > 64 ||
					row.dataBytes > 8_000_000
				)
					throw new Error('Native source patch exceeds its supported envelope.');
				const parts: string[] = [];
				for (let offset = 0; offset < row.chunks; offset += 4) {
					const page: Doc<'contractChangeContents'>[] | null = await ctx.runQuery(changePage, {
						...args,
						changeId: row._id,
						offset
					});
					if (!page) return null;
					if (
						page.length !== Math.min(4, row.chunks - offset) ||
						page.some(
							(part, index) =>
								part.order !== offset + index ||
								part.changeId !== row._id ||
								part.companyId !== row.companyId ||
								part.contractId !== row.contractId
						)
					)
						throw new Error('Native source patch page is incomplete.');
					parts.push(...page.map((part) => part.data));
				}
				const data = parts.join('');
				if (new TextEncoder().encode(data).length !== row.dataBytes)
					throw new Error('Native source patch size changed.');
				const patch = JSON.parse(data) as DocumentChange;
				if (
					patch.id !== row.patchKey ||
					!Array.isArray(patch.parts) ||
					!Array.isArray(patch.dependencies)
				)
					throw new Error('Native source patch identity is invalid.');
				proof = {
					kind: 'change',
					changeId: row._id,
					rowHash: receiptChunkFingerprint(canonicalJson(withoutNativeStage(row))),
					fingerprint: receiptChunkFingerprint(data),
					chunks: row.chunks,
					bytes: row.dataBytes
				};
			} else proof = snapshot;
			await ctx.runMutation(checkpoint, { ...args, proof });
		} catch (error) {
			const message =
				error instanceof ConvexError && typeof error.data === 'string'
					? error.data
					: error instanceof Error
						? error.message
						: 'This native operation could not complete.';
			await ctx.runMutation(fail, { ...args, error: message.slice(0, 2000) });
		}
		return null;
	}
});
