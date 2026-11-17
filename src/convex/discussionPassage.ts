import { expireOperation } from './operationExpiry';
import { ConvexError, v, type Infer } from 'convex/values';
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
import { assertContractDocumentManifest, contractDocumentSeal } from './contractDocuments';
import {
	passageIndexRow,
	storePassageIndex,
	supportedPassageIndex
} from './discussionPassageIndex';
import { indexedPassage } from '../lib/discussions/passage-index';
import { documentBytes } from './storageCapacity';

const passagePin = sourcePassage.pick(
	'inputHash',
	'documentId',
	'documentRevision',
	'manifestSeal'
);

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
async function currentManifest(
	ctx: QueryCtx,
	s: NonNullable<Awaited<ReturnType<typeof source>>>,
	pin: Infer<typeof passagePin>
) {
	if (
		s.context.root.documentId !== pin.documentId ||
		s.context.root.documentRevision !== pin.documentRevision
	)
		return null;
	const manifest = await ctx.db.get('contractDocuments', pin.documentId);
	assertContractDocumentManifest(manifest, {
		companyId: s.row.companyId,
		contractId: s.context.root._id
	});
	if (manifest.stage && !manifest.stage.sealed) throw new Error('Passage source is not sealed.');
	return contractDocumentSeal(manifest) === pin.manifestSeal ? manifest : null;
}
export const snapshot = internalQuery({
	args: { receiptId: v.id('operationReceipts') },
	returns: v.union(
		v.null(),
		v.object({
			manifest: schema.doc('contractDocuments'),
			inputs: v.string(),
			documentRevision: v.number(),
			manifestSeal: v.string(),
			passageIndex: v.union(v.bytes(), v.null())
		})
	),
	handler: async (ctx, { receiptId }) => {
		const s = await source(ctx, receiptId);
		if (!s) return null;
		const manifest = await ctx.db.get('contractDocuments', s.context.root.documentId);
		assertContractDocumentManifest(manifest, {
			companyId: s.row.companyId,
			contractId: s.context.root._id
		});
		if (manifest.stage && !manifest.stage.sealed) throw new Error('Passage source is not sealed.');
		const manifestSeal = contractDocumentSeal(manifest);
		const cached = await passageIndexRow(
			ctx,
			{
				companyId: s.row.companyId,
				contractId: s.context.root._id,
				documentId: manifest._id,
				documentRevision: s.context.root.documentRevision
			},
			manifestSeal
		);
		return {
			manifest,
			inputs: s.inputs,
			documentRevision: s.context.root.documentRevision,
			manifestSeal,
			passageIndex: cached?.data ?? null
		};
	}
});
export const page = internalQuery({
	args: {
		receiptId: v.id('operationReceipts'),
		pin: passagePin,
		offset: v.number()
	},
	returns: v.union(
		v.null(),
		v.object({ state: v.literal('changed') }),
		v.object({
			state: v.literal('current'),
			chunks: v.array(v.union(schema.doc('contractDocumentChunks'), v.null()))
		})
	),
	handler: async (ctx, args) => {
		const s = await source(ctx, args.receiptId);
		if (!s) return null;
		if (s.inputHash !== args.pin.inputHash) throw new Error('Passage input changed.');
		if (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset % 4)
			throw new Error('Invalid passage page.');
		const manifest = await currentManifest(ctx, s, args.pin);
		if (!manifest) return { state: 'changed' as const };
		return {
			state: 'current' as const,
			chunks: await Promise.all(
				manifest.chunkIds
					.slice(args.offset, args.offset + 4)
					.map((id) => ctx.db.get('contractDocumentChunks', id))
			)
		};
	}
});
export const checkpoint = internalMutation({
	args: {
		receiptId: v.id('operationReceipts'),
		pin: passagePin,
		interval: v.union(
			v.null(),
			v.object({ start: v.number(), end: v.number(), tapeLength: v.number() })
		),
		passageIndex: v.optional(v.bytes())
	},
	returns: v.union(v.null(), v.literal('changed'), v.literal('missing'), v.literal('sealed')),
	handler: async (ctx, { receiptId, pin, interval, passageIndex }) => {
		const s = await source(ctx, receiptId);
		if (!s) return null;
		if (await expireOperation(ctx, s.row)) return null;
		if (s.inputHash !== pin.inputHash) throw new Error('Passage input changed.');
		if (!(await currentManifest(ctx, s, pin))) return 'changed';
		if (!interval) return 'missing';
		if (
			!Number.isSafeInteger(interval.start) ||
			!Number.isSafeInteger(interval.end) ||
			!Number.isSafeInteger(interval.tapeLength) ||
			interval.start < 0 ||
			interval.end <= interval.start ||
			interval.end > interval.tapeLength
		)
			throw new Error('Invalid sealed source passage.');
		await admitDiscussionWork(ctx, { writes: 1, bytes: 8192 });
		await ctx.db.patch('operationReceipts', s.row._id, {
			preparation: { ...s.row.preparation!, sourcePassage: { ...pin, ...interval } }
		});
		if (passageIndex && supportedPassageIndex(passageIndex)) {
			if (s.input.command.kind !== 'create') throw new Error('Invalid passage command.');
			const checked = indexedPassage(passageIndex, s.input.command.anchor);
			if (
				checked.interval?.start !== interval.start ||
				checked.interval?.end !== interval.end ||
				checked.tapeLength !== interval.tapeLength
			)
				throw new Error('Prepared passage index does not match its passage.');
			const value = {
				companyId: s.row.companyId,
				contractId: s.context.root._id,
				documentId: pin.documentId,
				documentRevision: pin.documentRevision,
				manifestSeal: pin.manifestSeal,
				data: passageIndex
			};
			const bytes = documentBytes({ ...value, _id: 'x'.repeat(32), _creationTime: 0 });
			const metrics = await ctx.meta.getTransactionMetrics();
			if (
				metrics.documentsWritten.remaining > 48 &&
				metrics.bytesWritten.remaining > bytes + 1_000_000 &&
				metrics.databaseQueries.remaining > 48 &&
				metrics.documentsRead.remaining > 48
			)
				await storePassageIndex(ctx, value);
		}
		return 'sealed';
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
