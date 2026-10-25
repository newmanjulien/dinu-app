import { sha256 } from '@noble/hashes/sha2.js';
import { ConvexError, type Infer } from 'convex/values';
import type { historicalItem } from './playbookValidators';
import type { PlaybookItem } from '../lib/playbook/model';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import type { BaselineBlock } from '../lib/contract/source-model';
import { MAX_CONTRACT_BLOCKS } from '../lib/playbook/validation';

function canonicalFingerprint(value: unknown): string {
	function canonical(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(canonical);
		if (value && typeof value === 'object')
			return Object.fromEntries(
				Object.entries(value)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([key, value]) => [key, canonical(value)])
			);
		return value;
	}
	return Array.from(sha256(new TextEncoder().encode(JSON.stringify(canonical(value)))), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
export function canonicalBaselineFingerprint(blocks: readonly BaselineBlock[]) {
	return canonicalFingerprint(blocks);
}
export function stripStoredBlock({
	_id,
	_creationTime,
	companyId,
	baselineId,
	...block
}: Doc<'contractBlocks'>): BaselineBlock {
	return block;
}
export type HistoricalItem = Infer<typeof historicalItem>;
export function businessItem({ triggers, instructions, concessions }: PlaybookItem): PlaybookItem {
	return { triggers, ...(instructions === undefined ? {} : { instructions }), concessions };
}
export function snapshotItem({
	publishedRevisionId,
	...item
}: Doc<'playbookItems'>): HistoricalItem {
	return item;
}
export async function readBaseline(
	ctx: QueryCtx,
	baselineId: Id<'baselines'>,
	companyId: Id<'company'>,
	knownBaseline?: Doc<'baselines'>
) {
	const baseline = knownBaseline ?? (await ctx.db.get('baselines', baselineId));
	if (
		!baseline ||
		baseline._id !== baselineId ||
		baseline.companyId !== companyId ||
		baseline.state === 'deleting'
	)
		throw new ConvexError('This baseline is unavailable.');
	const rows = await ctx.db
		.query('contractBlocks')
		.withIndex('by_baselineId_and_order', (q) => q.eq('baselineId', baselineId))
		.take(MAX_CONTRACT_BLOCKS + 1);
	if (
		rows.length !== baseline.blockCount ||
		rows.length > MAX_CONTRACT_BLOCKS ||
		rows.some((row) => row.companyId !== companyId)
	)
		throw new ConvexError('This baseline is incomplete.');
	return { baseline, blocks: rows.map(stripStoredBlock) };
}

export async function baselineBlocks(
	ctx: QueryCtx,
	baselineId: Id<'baselines'>,
	companyId: Id<'company'>,
	knownBaseline?: Doc<'baselines'>
) {
	return (await readBaseline(ctx, baselineId, companyId, knownBaseline)).blocks;
}
