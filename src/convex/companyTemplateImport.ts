import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { baselineBlock } from './sourceValidators';
import { playbookItem } from './playbookValidators';
import { currentPointer, publishTemplate } from './templates';
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
		if (pointer?.importKey === args.importKey)
			return {
				blockCount: pointer.importBlockCount ?? 0,
				itemCount: pointer.importItemCount ?? 0,
				complete: Boolean(pointer.versionId && !pointer.maintenance)
			};
		if (
			pointer ||
			(await ctx.db
				.query('contractBlocks')
				.withIndex('by_companyId_and_order', (q) => q.eq('companyId', args.companyId))
				.first()) ||
			(await ctx.db
				.query('playbookItems')
				.withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
				.first())
		)
			throw new ConvexError(
				'This company already has template data or another import. Refusing to overwrite it.'
			);
		await ctx.db.insert('currentTemplate', {
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
		for (const item of args.items)
			await ctx.db.insert('playbookItems', { ...item, companyId: args.companyId });
		for (const block of args.blocks)
			await ctx.db.insert('contractBlocks', { ...block, companyId: args.companyId });
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
		const company = await requireCompany(ctx, args.companyId);
		const pointer = await currentPointer(ctx, args.companyId);
		if (
			pointer?.importKey !== args.importKey ||
			pointer.importBlockCount !== args.blockCount ||
			pointer.importItemCount !== args.itemCount
		)
			throw new ConvexError('Import is incomplete.');
		if (pointer.versionId && !pointer.maintenance) return null;
		if (!pointer.maintenance) throw new ConvexError('Import is not in maintenance.');
		await publishTemplate(ctx, company);
		await ctx.db.patch('currentTemplate', pointer._id, { maintenance: false });
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
			const result = await ctx.db
				.query('contractBlocks')
				.withIndex('by_companyId_and_order', (q) => q.eq('companyId', args.companyId))
				.paginate(opts);
			return {
				page: result.page.map(({ _id, _creationTime, companyId, ...block }) => block),
				cursor: result.continueCursor,
				done: result.isDone
			};
		}
		const result = await ctx.db
			.query('playbookItems')
			.withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
			.paginate(opts);
		return {
			page: result.page.map(({ triggers, instructions, concessions }) => ({
				triggers,
				...(instructions ? { instructions } : {}),
				concessions
			})),
			cursor: result.continueCursor,
			done: result.isDone
		};
	}
});
