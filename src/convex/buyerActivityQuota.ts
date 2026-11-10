import { RateLimiter } from '@convex-dev/rate-limiter';
import { ConvexError, v, type Infer } from 'convex/values';
import { components, internal } from './_generated/api';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { activityQuotaKey, discussionQuotaKey, quotaName } from './buyerActivityValidators';
import { cleanupBudget } from './cleanup';
import { assertStorageCapacity } from './storageCapacity';

const REFILL_MS = 60_000;
const bucket = (capacity: number) => ({
	kind: 'token bucket' as const,
	rate: capacity,
	period: REFILL_MS,
	capacity,
	shards: 1
});
const limiter = new RateLimiter(components.rateLimiter, {
	buyerBrowser: bucket(60),
	buyerCompany: bucket(3000),
	activityBrowser: bucket(60),
	activityLink: bucket(600),
	activityCompany: bucket(3000),
	discussionActor: bucket(60),
	discussionCompany: bucket(3000)
});
type Link = Pick<Doc<'buyerLinks'>, 'companyId' | 'contractId'> & {
	_id?: Doc<'buyerLinks'>['_id'];
};

function ownerFor(ctx: MutationCtx, name: Infer<typeof quotaName>, key: string) {
	return ctx.db
		.query('buyerActivityQuotaKeys')
		.withIndex('by_name_and_key', (q) => q.eq('name', name).eq('key', key))
		.unique();
}

/** Browser, link and company budgets bound best-effort activity intake. */
export async function consumeActivityQuota(ctx: MutationCtx, link: Link, browserId: string) {
	const common = { companyId: link.companyId, expiresAt: Date.now() + REFILL_MS };
	const owners: Infer<typeof activityQuotaKey>[] = [
		{
			...common,
			name: 'activityBrowser',
			key: `${link.contractId}:${browserId}`,
			contractId: link.contractId,
			linkId: link._id
		},
		{
			...common,
			name: 'activityLink',
			key: String(link._id ?? link.contractId),
			contractId: link.contractId,
			linkId: link._id
		},
		{ ...common, name: 'activityCompany', key: link.companyId }
	];
	for (const { name, key } of owners) {
		const result = await limiter.check(ctx, name, { key });
		if (!result.ok) return Math.max(1, Math.ceil(result.retryAfter / 1000));
	}
	await assertStorageCapacity(ctx, {
		documents: owners.length * 2,
		bytes: owners.length * 8000,
		queries: owners.length * 8,
		readDocuments: owners.length * 8
	});
	for (const owner of owners) {
		if (!(await limiter.limit(ctx, owner.name, { key: owner.key })).ok)
			throw new Error('Activity quota changed inside its transaction.');
		const existing = await ownerFor(ctx, owner.name, owner.key);
		if (existing) await ctx.db.replace('buyerActivityQuotaKeys', existing._id, owner);
		else await ctx.db.insert('buyerActivityQuotaKeys', owner);
	}
	return null;
}

/** Essential discussion state has its own component names, owner table and company budget. */
export async function consumeDiscussionQuota(ctx: MutationCtx, link: Link, actorKey: string) {
	const common = { companyId: link.companyId, expiresAt: Date.now() + REFILL_MS };
	const owners: Infer<typeof discussionQuotaKey>[] = [
		{
			...common,
			name: 'discussionActor',
			key: `${link.contractId}:${actorKey}`,
			contractId: link.contractId
		},
		{ ...common, name: 'discussionCompany', key: link.companyId }
	];
	for (const { name, key } of owners)
		if (!(await limiter.check(ctx, name, { key })).ok) return false;
	await assertStorageCapacity(ctx, { documents: 4, bytes: 16_000, queries: 16, readDocuments: 16 });
	for (const owner of owners) {
		if (!(await limiter.limit(ctx, owner.name, { key: owner.key })).ok)
			throw new Error('Discussion quota changed inside its transaction.');
		const existing = await ctx.db
			.query('discussionQuotaKeys')
			.withIndex('by_name_and_key', (q) => q.eq('name', owner.name).eq('key', owner.key))
			.unique();
		if (existing) await ctx.db.replace('discussionQuotaKeys', existing._id, owner);
		else await ctx.db.insert('discussionQuotaKeys', owner);
	}
	return true;
}

export async function resetQuota(
	ctx: MutationCtx,
	owner: Doc<'buyerActivityQuotaKeys'> | Doc<'discussionQuotaKeys'>
) {
	await limiter.reset(ctx, owner.name, { key: owner.key });
}

/** Fully idle buckets are full again, so removing them cannot grant additional tokens. */
export const expire = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const budget = cleanupBudget(ctx);
		let done = true;
		for (const table of ['buyerActivityQuotaKeys', 'discussionQuotaKeys'] as const) {
			if (
				!(await budget.drain(
					table,
					ctx.db.query(table).withIndex('by_expiresAt', (q) => q.lte('expiresAt', Date.now())),
					{
						beforeDelete: (owner) => resetQuota(ctx, owner)
					}
				))
			) {
				done = false;
				break;
			}
		}
		if (!done) await ctx.scheduler.runAfter(0, internal.buyerActivityQuota.expire, {});
		return null;
	}
});

/** Only for complete, buyer-only legacy inventories after the old writer has stopped. */
export const resetLegacy = internalMutation({
	args: {
		keys: v.array(
			v.object({
				name: v.union(v.literal('buyerBrowser'), v.literal('buyerCompany')),
				key: v.string()
			})
		),
		writerStoppedAt: v.number()
	},
	returns: v.object({ processed: v.number(), reset: v.number(), owned: v.number() }),
	handler: async (ctx, { keys, writerStoppedAt }) => {
		if (
			keys.length > 25 ||
			!Number.isFinite(writerStoppedAt) ||
			Date.now() < writerStoppedAt + REFILL_MS
		)
			throw new ConvexError('Wait a full refill interval and supply at most 25 legacy keys.');
		const budget = cleanupBudget(ctx);
		let processed = 0,
			reset = 0,
			owned = 0;
		for (const { name, key } of keys) {
			if (await budget.exhausted()) break;
			if (await ownerFor(ctx, name, key)) owned++;
			else {
				await limiter.reset(ctx, name, { key });
				reset++;
			}
			processed++;
		}
		return { processed, reset, owned };
	}
});
