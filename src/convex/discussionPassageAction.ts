import { ConvexError, v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { Infer } from 'convex/values';
import { decodeContractDocumentChunks } from './contractDocuments';
import { discussionTape, passageInterval } from '../lib/discussions/tape';
import type { discussionCommand } from '../lib/discussions/validators';
import type { sourcePassage } from './discussionPreparationValidators';
import { fingerprint } from './discussionService';
const snapshot = makeFunctionReference<
	'query',
	{ receiptId: Id<'operationReceipts'> },
	{ manifest: Doc<'contractDocuments'>; inputs: string } | null
>('discussionPassage:snapshot');
const page = makeFunctionReference<
	'query',
	{
		receiptId: Id<'operationReceipts'>;
		documentId: Id<'contractDocuments'>;
		inputHash: string;
		offset: number;
	},
	(Doc<'contractDocumentChunks'> | null)[] | null
>('discussionPassage:page');
const checkpoint = makeFunctionReference<
	'mutation',
	{ receiptId: Id<'operationReceipts'>; passage: Infer<typeof sourcePassage> },
	null
>('discussionPassage:checkpoint');
const fail = makeFunctionReference<
	'mutation',
	{ receiptId: Id<'operationReceipts'>; inputHash?: string; error: string },
	null
>('discussionPassage:fail');
/** Exceptional creation resolves one immutable supported document through bounded
 * private pages and persists only its exact passage seal, never a copied document. */
export const resolve = internalAction({
	args: { receiptId: v.id('operationReceipts') },
	returns: v.null(),
	handler: async (ctx, owner) => {
		let inputHash: string | undefined;
		try {
			const s = await ctx.runQuery(snapshot, owner);
			if (!s) return null;
			inputHash = fingerprint(s.inputs);
			const input = JSON.parse(s.inputs) as {
					command: Extract<Infer<typeof discussionCommand>, { kind: 'create' }>;
				},
				rows: (Doc<'contractDocumentChunks'> | null)[] = [];
			for (let offset = 0; offset < s.manifest.chunkIds.length; offset += 4) {
				const found = await ctx.runQuery(page, {
					...owner,
					documentId: s.manifest._id,
					inputHash,
					offset
				});
				if (!found) return null;
				rows.push(...found);
			}
			const tape = discussionTape(decodeContractDocumentChunks(s.manifest, rows)),
				interval = passageInterval(tape, input.command.anchor);
			if (!interval) throw new ConvexError('This passage changed. Select the current wording.');
			await ctx.runMutation(checkpoint, {
				...owner,
				passage: {
					inputHash,
					documentId: s.manifest._id,
					documentRevision: input.command.revision,
					...interval,
					tapeLength: tape.length
				}
			});
		} catch (error) {
			await ctx.runMutation(fail, {
				...owner,
				inputHash,
				error:
					error instanceof ConvexError && typeof error.data === 'string'
						? error.data
						: error instanceof Error
							? error.message
							: 'This passage could not be resolved.'
			});
		}
		return null;
	}
});
