import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { baselineBlock } from './sourceValidators';
import { playbookItem } from './playbookValidators';
import { currentPointer, publishTemplate, readLiveSnapshot } from './templates';
import { createAuthoringItem } from './playbookItemRevisions';
import { canonicalBaselineFingerprint, stripStoredBlock, businessItem } from './baselineStorage';
import { documentBytes, publicationCapacity } from './templateCapacity';
import { MAX_CONTRACT_BLOCKS, MAX_PLAYBOOK_ITEMS } from '../lib/playbook/validation';
import { paginationOptsValidator } from 'convex/server';
import { requireCompany } from './auth';

const scope = { companyId: v.id('company'), importKey: v.string() };
const progress = v.object({ blockCount: v.number(), itemCount: v.number(), complete: v.boolean() });

// Initial templates only. The content fingerprint and committed counters make
// an interrupted batch resumable without restoring intentionally deleted data.
export const begin = internalMutation({
	args: scope,
	returns: progress,
	handler: async (ctx, args) => {
		await requireCompany(ctx, args.companyId);
		if (!/^[a-f0-9]{64}$/.test(args.importKey))
			throw new ConvexError('A company and SHA-256 content fingerprint are required.');
		const pointer = await currentPointer(ctx, args.companyId);
		if (pointer?.importKey === args.importKey) {
			if (pointer.importBlockCount === undefined || pointer.importItemCount === undefined)
				throw new ConvexError('Import progress is incomplete.');
			return {
				blockCount: pointer.importBlockCount,
				itemCount: pointer.importItemCount,
				complete: Boolean(pointer.versionId && !pointer.maintenance)
			};
		}
		if (
			pointer ||
			(await ctx.db
				.query('playbookItems')
				.withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
				.first()) ||
			(await ctx.db
				.query('templateVersions')
				.withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
				.first()) ||
			(await ctx.db
				.query('baselines')
				.withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
				.first())
		)
			throw new ConvexError(
				'This company already has template data or another import. Refusing to overwrite it.'
			);
		const baselineId = await ctx.db.insert('baselines', {
			companyId: args.companyId,
			state: 'prepared',
			source: 'seed',
			fingerprint: args.importKey,
			blockCount: 0,
			issues: []
		});
		await ctx.db.insert('currentTemplate', {
			baselineId,
			companyId: args.companyId,
			maintenance: true,
			importKey: args.importKey,
			importBlockCount: 0,
			importItemCount: 0
		});
		return { blockCount: 0, itemCount: 0, complete: false };
	}
});
export const append = internalMutation({
	args: {
		...scope,
		expectedBlockCount: v.number(),
		expectedItemCount: v.number(),
		blocks: v.array(baselineBlock),
		items: v.array(playbookItem)
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireCompany(ctx, args.companyId);
		const pointer = await currentPointer(ctx, args.companyId);
		if (
			!pointer?.maintenance ||
			pointer.versionId ||
			pointer.importKey !== args.importKey ||
			pointer.importBlockCount !== args.expectedBlockCount ||
			pointer.importItemCount !== args.expectedItemCount
		)
			throw new ConvexError('Import progress changed. Read progress before retrying.');
		if (
			args.blocks.length + args.items.length > 4 ||
			new TextEncoder().encode(JSON.stringify({ blocks: args.blocks, items: args.items }))
				.byteLength > 2_000_000
		)
			throw new ConvexError('Import batches support at most four records and 2 MB.');
		if (
			args.expectedBlockCount + args.blocks.length > MAX_CONTRACT_BLOCKS ||
			args.expectedItemCount + args.items.length > MAX_PLAYBOOK_ITEMS
		)
			throw new ConvexError('Import exceeds supported size.');
		for (const item of args.items)
			await createAuthoringItem(ctx, { ...item, companyId: args.companyId });
		const blocks = args.blocks.map((block) => ({
			...block,
			companyId: args.companyId,
			baselineId: pointer.baselineId
		}));
		await publicationCapacity(ctx, {
			documents: blocks.length,
			bytes: blocks.reduce((sum, block) => sum + documentBytes(block), 0)
		});
		for (const block of blocks) await ctx.db.insert('contractBlocks', block);
		await ctx.db.patch('baselines', pointer.baselineId, {
			blockCount: args.expectedBlockCount + args.blocks.length
		});
		await ctx.db.patch('currentTemplate', pointer._id, {
			importBlockCount: args.expectedBlockCount + args.blocks.length,
			importItemCount: args.expectedItemCount + args.items.length
		});
		return null;
	}
});
export const finish = internalMutation({
	args: { ...scope, blockCount: v.number(), itemCount: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		await requireCompany(ctx, args.companyId);
		const pointer = await currentPointer(ctx, args.companyId);
		if (
			pointer?.importKey !== args.importKey ||
			pointer.importBlockCount !== args.blockCount ||
			pointer.importItemCount !== args.itemCount
		)
			throw new ConvexError('Import is incomplete.');
		if (pointer.versionId && !pointer.maintenance) return null;
		if (!pointer.maintenance) throw new ConvexError('Import is not in maintenance.');
		const captured = await readLiveSnapshot(ctx, args.companyId, pointer);
		if (captured.blocks.length !== args.blockCount || captured.items.length !== args.itemCount)
			throw new ConvexError('Import counts do not match stored content.');
		const fingerprint = canonicalBaselineFingerprint(captured.blocks);
		const publishedAt = Date.now();
		await publicationCapacity(ctx, {
			documents: 1,
			bytes: documentBytes({ ...captured.baseline, state: 'published', fingerprint, publishedAt })
		});
		await ctx.db.patch('baselines', pointer.baselineId, {
			state: 'published',
			fingerprint,
			publishedAt
		});
		captured.pointer = { ...pointer, maintenance: false, baselineFingerprint: fingerprint };
		await publishTemplate(ctx, args.companyId, captured);
		// publishTemplate writes the complete captured pointer in the same transaction.
		return null;
	}
});

// Bounded operator audit. No public API exposes companies or their templates.
export const readPage = internalQuery({
	args: {
		companyId: v.id('company'),
		table: v.union(v.literal('blocks'), v.literal('items')),
		paginationOpts: paginationOptsValidator
	},
	returns: v.object({
		page: v.array(v.union(baselineBlock, playbookItem)),
		cursor: v.string(),
		done: v.boolean()
	}),
	handler: async (ctx, args) => {
		await requireCompany(ctx, args.companyId);
		const opts = {
			...args.paginationOpts,
			numItems: Math.min(args.paginationOpts.numItems, 25),
			maximumRowsRead: 25,
			maximumBytesRead: 2_000_000
		};
		if (args.table === 'blocks') {
			const pointer = await currentPointer(ctx, args.companyId);
			if (!pointer) return { page: [], cursor: '', done: true };
			const result = await ctx.db
				.query('contractBlocks')
				.withIndex('by_companyId_and_baselineId_and_order', (q) =>
					q.eq('companyId', args.companyId).eq('baselineId', pointer.baselineId)
				)
				.paginate(opts);
			return {
				page: result.page.map(stripStoredBlock),
				cursor: result.continueCursor,
				done: result.isDone
			};
		}
		const result = await ctx.db
			.query('playbookItems')
			.withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
			.paginate(opts);
		return {
			page: result.page.map(businessItem),
			cursor: result.continueCursor,
			done: result.isDone
		};
	}
});
