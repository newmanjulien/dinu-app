import { expireOperation } from './operationExpiry';
import { ConvexError, v } from 'convex/values';
import { validate } from 'convex-helpers/validators';
import { internalQuery, internalMutation, type QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import schema from './schema';
import { discussionCommand } from '../lib/discussions/validators';
import { sourcePassage } from './discussionPreparationValidators';
import { authorizePreparedOperation } from './discussionPreparation';
import { discussionContext } from './discussionContext';
import { fingerprint } from './discussionService';
import { receiptPayload, sealReceipt } from './operationReceipts';
import { admitDiscussionWork } from './discussionMaps';

async function source(ctx: QueryCtx, receiptId: Id<'operationReceipts'>) {
	const row = await ctx.db.get('operationReceipts', receiptId);
	if (!row || row.state !== 'preparing') return null;
	const { actor, contract } = await authorizePreparedOperation(ctx, row);
	if (row.kind !== 'discussion-write' || !row.preparation)
		throw new Error('Invalid passage preparation owner.');
	const payload = await receiptPayload(ctx, row),
		input: unknown = JSON.parse(payload.inputs);
	if (
		!validate(
			v.object({ token: v.string(), operationId: v.string(), command: discussionCommand }),
			input
		) ||
		input.command.kind !== 'create' ||
		input.operationId !== row.operationId
	)
		throw new Error('Invalid original passage input.');
	const link = actor.kind === 'buyer' ? { id: actor.linkId, token: actor.token } : actor.link;
	if (!link || link.token !== input.token) throw new Error('Passage link ownership changed.');
	const context = await discussionContext(ctx, input);
	if (context.root._id !== contract.root._id || context.link._id !== link.id)
		throw new Error('Passage contract ownership changed.');
	if (
		input.command.contentIdentity !== context.root.documentId ||
		input.command.revision !== context.root.documentRevision
	)
		throw new ConvexError(
			'This passage changed. Select the current wording to comment. Your draft is still here.'
		);
	return { row, input, inputs: payload.inputs, inputHash: fingerprint(payload.inputs), context };
}
export const snapshot = internalQuery({
	args: { receiptId: v.id('operationReceipts') },
	returns: v.union(
		v.null(),
		v.object({ manifest: schema.doc('contractDocuments'), inputs: v.string() })
	),
	handler: async (ctx, { receiptId }) => {
		const s = await source(ctx, receiptId);
		if (!s) return null;
		const manifest = await ctx.db.get('contractDocuments', s.context.root.documentId);
		if (
			!manifest ||
			manifest.companyId !== s.row.companyId ||
			manifest.contractId !== s.row.contractId
		)
			throw new Error('Passage source manifest ownership changed.');
		return { manifest, inputs: s.inputs };
	}
});
export const page = internalQuery({
	args: {
		receiptId: v.id('operationReceipts'),
		documentId: v.id('contractDocuments'),
		inputHash: v.string(),
		offset: v.number()
	},
	returns: v.union(v.null(), v.array(v.union(schema.doc('contractDocumentChunks'), v.null()))),
	handler: async (ctx, args) => {
		const s = await source(ctx, args.receiptId);
		if (!s || s.inputHash !== args.inputHash || s.context.root.documentId !== args.documentId)
			return null;
		if (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset % 4)
			throw new Error('Invalid passage page.');
		const manifest = await ctx.db.get('contractDocuments', args.documentId);
		if (
			!manifest ||
			manifest.companyId !== s.row.companyId ||
			manifest.contractId !== s.row.contractId
		)
			throw new Error('Invalid passage source.');
		return Promise.all(
			manifest.chunkIds
				.slice(args.offset, args.offset + 4)
				.map((id) => ctx.db.get('contractDocumentChunks', id))
		);
	}
});
export const checkpoint = internalMutation({
	args: { receiptId: v.id('operationReceipts'), passage: sourcePassage },
	returns: v.null(),
	handler: async (ctx, { receiptId, passage }) => {
		const s = await source(ctx, receiptId);
		if (!s) return null;
		if (await expireOperation(ctx, s.row)) return null;
		if (
			s.inputHash !== passage.inputHash ||
			s.context.root.documentId !== passage.documentId ||
			s.context.root.documentRevision !== passage.documentRevision ||
			!Number.isSafeInteger(passage.start) ||
			!Number.isSafeInteger(passage.end) ||
			!Number.isSafeInteger(passage.tapeLength) ||
			passage.start < 0 ||
			passage.end <= passage.start ||
			passage.end > passage.tapeLength
		)
			throw new Error('Invalid sealed source passage.');
		await admitDiscussionWork(ctx, { writes: 1, bytes: 8192 });
		await ctx.db.patch('operationReceipts', s.row._id, {
			preparation: { ...s.row.preparation!, sourcePassage: passage }
		});
		return null;
	}
});
export const fail = internalMutation({
	args: {
		receiptId: v.id('operationReceipts'),
		inputHash: v.optional(v.string()),
		error: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('operationReceipts', args.receiptId);
		if (!row || row.state !== 'preparing' || row.kind !== 'discussion-write') return null;
		if (await expireOperation(ctx, row)) return null;
		const payload = await receiptPayload(ctx, row);
		if (args.inputHash && fingerprint(payload.inputs) !== args.inputHash)
			throw new Error('Passage failure original input changed.');
		await sealReceipt(ctx, row, payload.inputs, { state: 'failed', error: args.error });
		return null;
	}
});
