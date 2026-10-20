import { requireMembership, requireCompany } from './auth';
import { sha256 } from '@noble/hashes/sha2.js';
import { baselineBlock } from './sourceValidators';
import { validateBaseline } from '../lib/contract/validate-source';
import { BASELINE_MAX_BLOCKS, BASELINE_MAX_BYTES } from '../lib/contract/import/limits';
import { ConvexError, v, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
	internalMutation,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import { snapshot } from './savedContractValidators';
import { selections } from './contractValidators';
import { MAX_SELECTED_CONCESSIONS } from '../lib/contract/selection-limits';
import {
	MAX_CONTRACT_BLOCKS,
	MAX_PLAYBOOK_ITEMS,
	PlaybookValidationError
} from '../lib/playbook/validation';
import { validatePlaybook } from '../lib/playbook/audit';

export function currentPointer(ctx: QueryCtx, companyId: Id<'company'>) {
	return ctx.db
		.query('currentTemplate')
		.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
		.unique();
}
export async function assertAuthoringAvailable(ctx: QueryCtx, companyId: Id<'company'>) {
	const pointer = await currentPointer(ctx, companyId);
	if (pointer?.maintenance)
		throw publicationRejected('Template maintenance is in progress. Try again shortly.');
	if (!pointer?.versionId) throw publicationRejected('The baseline contract is not available.');
}
function publicationRejected(message: string) {
	return new ConvexError({ code: 'TEMPLATE_PUBLICATION_REJECTED', message });
}
export async function readLiveSnapshot(ctx: QueryCtx, companyId: Id<'company'>) {
	const [records, items] = await Promise.all([
		ctx.db
			.query('contractBlocks')
			.withIndex('by_companyId_and_order', (q) => q.eq('companyId', companyId))
			.take(MAX_CONTRACT_BLOCKS + 1),
		ctx.db
			.query('playbookItems')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(MAX_PLAYBOOK_ITEMS + 1)
	]);
	if (!records.length) throw publicationRejected('The baseline contract is not available.');
	if (records.length > MAX_CONTRACT_BLOCKS || items.length > MAX_PLAYBOOK_ITEMS)
		throw publicationRejected('Contract exceeds supported size.');
	return {
		blocks: records.map(({ _id, _creationTime, companyId: _companyId, ...block }) => block),
		items
	};
}

/** Publication and its authoring change commit together, or neither commits. */
export async function publishTemplate(ctx: MutationCtx, company: Doc<'company'>) {
	const companyId = company._id;
	const captured = await readLiveSnapshot(ctx, companyId);
	const bytes = new TextEncoder().encode(JSON.stringify(captured)).byteLength;
	if (bytes > 8_000_000) throw publicationRejected('Contract snapshot exceeds supported size.');
	try {
		validatePlaybook(captured.blocks, captured.items);
	} catch (error) {
		if (error instanceof PlaybookValidationError) throw publicationRejected(error.message);
		throw error;
	}
	return publishSnapshot(ctx, companyId, captured, bytes, await currentPointer(ctx, companyId));
}

/** Receives an already validated, captured snapshot; never rereads live content. */
async function publishSnapshot(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	captured: Awaited<ReturnType<typeof readLiveSnapshot>>,
	bytes: number,
	pointer: Doc<'currentTemplate'> | null,
	baselineFingerprint?: string
) {
	// Reserve metadata/pointer and table wrappers up front. Recheck once after
	// copying to reject capacity exhaustion before exposing the new version.
	const capacity = async (documents: number, bytes: number) => {
		const metrics = await ctx.meta.getTransactionMetrics();
		if (
			metrics.documentsWritten.remaining < documents + 2 ||
			metrics.bytesWritten.remaining < bytes + 65_536 ||
			metrics.databaseQueries.remaining < documents + 2
		)
			throw publicationRejected(
				'Template publication exceeds transaction capacity. Reduce the template size.'
			);
	};
	const count = captured.blocks.length + captured.items.length;
	await capacity(count + 1, bytes + count * 512);
	const versionId = await ctx.db.insert('templateVersions', {
		companyId,
		publishedAt: Date.now(),
		blockCount: captured.blocks.length,
		itemCount: captured.items.length,
		snapshotBytes: bytes
	});
	for (const block of captured.blocks) {
		await ctx.db.insert('templateVersionBlocks', { companyId, versionId, block });
	}
	for (const item of captured.items) {
		await ctx.db.insert('templateVersionItems', { companyId, versionId, itemId: item._id, item });
	}
	await capacity(1, 0);
	if (pointer)
		await ctx.db.patch('currentTemplate', pointer._id, {
			versionId,
			...(baselineFingerprint ? { baselineFingerprint } : {})
		});
	else
		await ctx.db.insert('currentTemplate', {
			companyId,
			versionId,
			maintenance: false,
			...(baselineFingerprint ? { baselineFingerprint } : {})
		});
	return versionId;
}
export async function readVersion(
	ctx: QueryCtx,
	versionId: Id<'templateVersions'>,
	companyId: Id<'company'>
) {
	return (await versionReader(ctx, versionId, companyId)).read();
}
export const current = query({
	args: { membershipId: v.id('memberships') },
	returns: v.union(v.null(), v.object({ versionId: v.id('templateVersions'), snapshot })),
	handler: async (ctx, args) => {
		const { companyId } = await requireMembership(ctx, args.membershipId);
		const pointer = await currentPointer(ctx, companyId);
		return pointer?.versionId && !pointer.maintenance
			? {
					versionId: pointer.versionId,
					snapshot: await readVersion(ctx, pointer.versionId, companyId)
				}
			: null;
	}
});
export const version = query({
	args: { membershipId: v.id('memberships'), versionId: v.id('templateVersions') },
	returns: snapshot,
	handler: async (ctx, { versionId, membershipId }) => {
		const { companyId } = await requireMembership(ctx, membershipId);
		return readVersion(ctx, versionId, companyId);
	}
});
export const initialize = internalMutation({
	args: { companyId: v.id('company') },
	returns: v.id('templateVersions'),
	handler: async (ctx, { companyId }) => {
		const company = await requireCompany(ctx, companyId);
		const pointer = await currentPointer(ctx, companyId);
		if (pointer?.maintenance)
			throw new ConvexError('Finish template maintenance before initialization.');
		return pointer?.versionId ?? (await publishTemplate(ctx, company));
	}
});
// Callers authorize the company or contract first. Validate the immutable parent
// once per transaction; use its counts for every complete read.
export function snapshotReader(ctx: QueryCtx, contract: Doc<'savedContracts'>) {
	return versionReader(ctx, contract.templateVersionId, contract.companyId);
}
// The caller validates the immutable parent and company before reading its children.
export async function readVersionItem(
	ctx: QueryCtx,
	versionId: Id<'templateVersions'>,
	itemId: Id<'playbookItems'>
) {
	const row = await ctx.db
		.query('templateVersionItems')
		.withIndex('by_versionId_and_itemId', (q) => q.eq('versionId', versionId).eq('itemId', itemId))
		.unique();
	return row?.item ?? null;
}
async function versionReader(
	ctx: QueryCtx,
	versionId: Id<'templateVersions'>,
	companyId: Id<'company'>
) {
	const version = await ctx.db.get('templateVersions', versionId);
	if (!version || version.companyId !== companyId)
		throw new ConvexError('This template version is unavailable.');
	const { blockCount, itemCount } = version;
	async function blocks() {
		const rows = await ctx.db
			.query('templateVersionBlocks')
			.withIndex('by_versionId', (q) => q.eq('versionId', versionId))
			.take(MAX_CONTRACT_BLOCKS + 1);
		if (rows.length !== blockCount) throw new ConvexError('This template version is incomplete.');
		return rows.map((row) => row.block).sort((a, b) => a.order - b.order);
	}
	return {
		blocks,
		async selectedItems(selectedConcessions: Infer<typeof selections>) {
			const selectedIds = Object.keys(selectedConcessions) as Id<'playbookItems'>[];
			if (selectedIds.length > MAX_SELECTED_CONCESSIONS)
				throw new ConvexError('Too many selected concessions.');
			const items: Doc<'playbookItems'>[] = [];
			// Read only selected items, with bounded concurrent I/O.
			for (let offset = 0; offset < selectedIds.length; offset += 64) {
				const selected = selectedIds.slice(offset, offset + 64);
				const rows = await Promise.all(selected.map((id) => readVersionItem(ctx, versionId, id)));
				for (let index = 0; index < rows.length; index++) {
					const item = rows[index];
					if (!item?.concessions.some((c) => c.id === selectedConcessions[selected[index]]))
						throw new ConvexError('A selected concession does not belong to this contract.');
					items.push(item);
				}
			}
			return items;
		},
		async read() {
			const [snapshotBlocks, items] = await Promise.all([
				blocks(),
				ctx.db
					.query('templateVersionItems')
					.withIndex('by_versionId', (q) => q.eq('versionId', versionId))
					.take(MAX_PLAYBOOK_ITEMS + 1)
			]);
			if (items.length !== itemCount) throw new ConvexError('This template version is incomplete.');
			return { blockCount, itemCount, blocks: snapshotBlocks, items: items.map((row) => row.item) };
		}
	};
}

/** One permanent baseline; playbook publication can still create later versions. */
export const publishBaseline = mutation({
	args: { membershipId: v.id('memberships'), blocks: v.array(baselineBlock) },
	returns: v.id('templateVersions'),
	handler: async (ctx, { membershipId, blocks }) => {
		const access = await requireMembership(ctx, membershipId);
		if (access.role !== 'admin')
			throw new ConvexError('Only an admin can publish the company baseline.');
		if (!blocks.length || blocks.length > BASELINE_MAX_BLOCKS)
			throw publicationRejected('The baseline must contain between 1 and 400 blocks.');
		function canonical(value: unknown): unknown {
			if (Array.isArray(value)) return value.map(canonical);
			if (value && typeof value === 'object')
				return Object.fromEntries(
					Object.entries(value)
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([k, v]) => [k, canonical(v)])
				);
			return value;
		}
		const encoded = new TextEncoder().encode(JSON.stringify(canonical(blocks)));
		if (encoded.byteLength > BASELINE_MAX_BYTES)
			throw publicationRejected('The baseline exceeds 512 KB.');
		try {
			validateBaseline(blocks);
		} catch (error) {
			if (error instanceof PlaybookValidationError) throw publicationRejected(error.message);
			throw error;
		}
		const fingerprint = Array.from(sha256(encoded), (b) => b.toString(16).padStart(2, '0')).join(
			''
		);
		const pointer = await currentPointer(ctx, access.companyId);
		if (pointer?.versionId && !pointer.maintenance && pointer.baselineFingerprint === fingerprint)
			return pointer.versionId;
		const [existing, items, versions] = await Promise.all([
			ctx.db
				.query('contractBlocks')
				.withIndex('by_companyId_and_order', (q) => q.eq('companyId', access.companyId))
				.take(1),
			ctx.db
				.query('playbookItems')
				.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
				.take(1),
			ctx.db
				.query('templateVersions')
				.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
				.take(1)
		]);
		if (pointer || existing.length || items.length || versions.length)
			throw publicationRejected(
				'This company already has a baseline or an import in progress. Its baseline cannot be replaced.'
			);
		const metrics = await ctx.meta.getTransactionMetrics();
		if (
			metrics.documentsWritten.remaining < blocks.length * 2 + 3 ||
			metrics.bytesWritten.remaining < encoded.byteLength * 2 + blocks.length * 1024 + 65536 ||
			metrics.databaseQueries.remaining < blocks.length * 2 + 10
		)
			throw publicationRejected(
				'The baseline exceeds transaction capacity. Shorten it before publishing.'
			);
		for (const block of blocks)
			await ctx.db.insert('contractBlocks', { ...block, companyId: access.companyId });
		return publishSnapshot(
			ctx,
			access.companyId,
			{ blocks, items: [] },
			new TextEncoder().encode(JSON.stringify({ blocks, items: [] })).length,
			null,
			fingerprint
		);
	}
});
