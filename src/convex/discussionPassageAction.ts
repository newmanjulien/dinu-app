import { ConvexError, v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { Infer } from 'convex/values';
import { decodeContractDocumentChunks } from './contractDocuments';
import { discussionTape, passageInterval } from '../lib/discussions/tape';
import { indexedPassage } from '../lib/discussions/passage-index';
import { plannedPassageIndex } from './discussionPassageIndex';
import type { discussionCommand } from '../lib/discussions/validators';
import type { sourcePassage } from './discussionPreparationValidators';
import { fingerprint } from './discussionService';
type Pin = Pick<
	Infer<typeof sourcePassage>,
	'inputHash' | 'documentId' | 'documentRevision' | 'manifestSeal'
>;
const snapshot = makeFunctionReference<
	'query',
	{ receiptId: Id<'operationReceipts'> },
	{
		manifest: Doc<'contractDocuments'>;
		inputs: string;
		documentRevision: number;
		manifestSeal: string;
		passageIndex: ArrayBuffer | null;
	} | null
>('discussionPassage:snapshot');
const page = makeFunctionReference<
	'query',
	{
		receiptId: Id<'operationReceipts'>;
		pin: Pin;
		offset: number;
	},
	| { state: 'changed' }
	| { state: 'current'; chunks: (Doc<'contractDocumentChunks'> | null)[] }
	| null
>('discussionPassage:page');
const checkpoint = makeFunctionReference<
	'mutation',
	{
		receiptId: Id<'operationReceipts'>;
		pin: Pin;
		interval: { start: number; end: number; tapeLength: number } | null;
		passageIndex?: ArrayBuffer;
	},
	'changed' | 'missing' | 'sealed' | null
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
			attempt: for (let revision = 0; revision < 3; revision++) {
				const s = await ctx.runQuery(snapshot, owner);
				if (!s) return null;
				inputHash = fingerprint(s.inputs);
				const input = JSON.parse(s.inputs) as {
					command: Extract<Infer<typeof discussionCommand>, { kind: 'create' }>;
				};
				const pin: Pin = {
					inputHash,
					documentId: s.manifest._id,
					documentRevision: s.documentRevision,
					manifestSeal: s.manifestSeal
				};
				let interval: { start: number; end: number } | null;
				let tapeLength: number;
				let passageIndex: ArrayBuffer | undefined;
				if (s.passageIndex) {
					const indexed = indexedPassage(s.passageIndex, input.command.anchor);
					interval = indexed.interval;
					tapeLength = indexed.tapeLength;
				} else {
					const rows: (Doc<'contractDocumentChunks'> | null)[] = [];
					for (let offset = 0; offset < s.manifest.chunkIds.length; offset += 4) {
						const found = await ctx.runQuery(page, { ...owner, pin, offset });
						if (!found) return null;
						if (found.state === 'changed') continue attempt;
						rows.push(...found.chunks);
					}
					const tape = discussionTape(decodeContractDocumentChunks(s.manifest, rows));
					interval = passageInterval(tape, input.command.anchor);
					tapeLength = tape.length;
					passageIndex = plannedPassageIndex(
						{
							companyId: s.manifest.companyId,
							contractId: s.manifest.contractId,
							documentId: pin.documentId,
							documentRevision: pin.documentRevision
						},
						pin.manifestSeal,
						tape
					)?.value.data;
				}
				const result = await ctx.runMutation(checkpoint, {
					...owner,
					pin,
					interval: interval ? { ...interval, tapeLength } : null,
					...(passageIndex ? { passageIndex } : {})
				});
				if (result === 'changed') continue;
				if (result === 'missing')
					throw new ConvexError('This passage changed. Select the current wording to comment.');
				return null;
			}
			throw new ConvexError('The document changed while checking this passage. Try again.');
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
