import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { concessionReviews } from './contractValidators';
import { chunks } from './emailSnapshots';

export function applicationKey(concessionId: string, lifecycle: string) {
	return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([concessionId, lifecycle]))));
}
type Attribution = Doc<'reviewAttributions'>['entries'][number];
export async function attributionsFor(ctx: QueryCtx, contractId: Id<'savedContracts'>) {
	const rows = await ctx.db
		.query('reviewAttributions')
		.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
		.take(32);
	if (rows.length === 32) throw new Error('Review attribution exceeds its bounds.');
	return { rows, entries: rows.flatMap((row) => row.entries) };
}

/** Current attribution is maintained with reviews; audit history remains independent. */
export async function updateAttributions(
	ctx: MutationCtx,
	contract: Doc<'savedContracts'>,
	reviews: Infer<typeof concessionReviews>,
	changes: Attribution[]
) {
	if (
		!changes.length &&
		Object.keys(contract.reviews).length === Object.keys(reviews).length &&
		Object.entries(reviews).every(([id, review]) => {
			const previous = contract.reviews[id as Id<'playbookItems'>];
			return (
				previous?.concessionId === review.concessionId &&
				previous.lifecycle === review.lifecycle &&
				previous.status === review.status
			);
		})
	)
		return;
	const current = await attributionsFor(ctx, contract._id);
	const pending = new Map(changes.map((entry) => [entry.itemId, entry]));
	const valid = (entry: Attribution) => {
		const review = reviews[entry.itemId];
		return (
			review &&
			review.status !== 'pending' &&
			entry.applicationKey === applicationKey(review.concessionId, review.lifecycle)
		);
	};
	const groups = current.rows.map((row) => ({
		row,
		entries: row.entries.flatMap((previous) => {
			const entry = pending.get(previous.itemId) ?? previous;
			pending.delete(previous.itemId);
			return valid(entry) ? [entry] : [];
		})
	}));
	const additions = [...pending.values()].filter(valid);
	if (additions.length) {
		const last = groups.at(-1);
		if (last) last.entries.push(...additions);
		else
			for (const entries of chunks(additions))
				await ctx.db.insert('reviewAttributions', {
					companyId: contract.companyId,
					contractId: contract._id,
					entries
				});
	}
	for (const { row, entries } of groups) {
		if (
			entries.length === row.entries.length &&
			entries.every((entry, index) => entry === row.entries[index])
		)
			continue;
		await ctx.db.delete('reviewAttributions', row._id);
		for (const chunkEntries of chunks(entries))
			await ctx.db.insert('reviewAttributions', {
				companyId: contract.companyId,
				contractId: contract._id,
				entries: chunkEntries
			});
	}
}
export function attribution(
	itemId: Id<'playbookItems'>,
	concessionId: string,
	lifecycle: string,
	reviewer: Pick<Doc<'profiles'>, '_id' | 'name'>
): Attribution {
	return {
		itemId,
		applicationKey: applicationKey(concessionId, lifecycle),
		reviewerId: reviewer._id,
		reviewerName: reviewer.name.slice(0, 200)
	};
}
