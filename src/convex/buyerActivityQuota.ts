import { RateLimiter } from '@convex-dev/rate-limiter';
import { ConvexError, v, type Infer } from 'convex/values';
import { components, internal } from './_generated/api';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { activityQuotaKey, discussionQuotaKey, quotaName } from './buyerActivityValidators';
import { cleanupBudget } from './cleanup';

const REFILL_MS = 60_000;
const bucket = (capacity: number, shards = 1) => ({
	kind: 'token bucket' as const,
	rate: capacity,
	period: REFILL_MS,
	capacity,
	shards
});
const limiter = new RateLimiter(components.rateLimiter, {
	activityBrowser: bucket(60),
	activityLink: bucket(600, 4),
	activityCompany: bucket(3000, 8),
	discussionActor: bucket(60),
	discussionCompany: bucket(3000, 8)
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
export async function consumeActivityQuota(
	ctx: MutationCtx,
	link: Link,
	browserId: string,
	count = 1
) {
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
	const checks = await Promise.all(
		owners.map(({ name, key }) => limiter.check(ctx, name, { key, count }))
	);
	const denied = checks.find((result) => !result.ok);
	if (denied && !denied.ok) return Math.max(1, Math.ceil(denied.retryAfter / 1000));
	await Promise.all(
		owners.map(async (owner) => {
			if (!(await limiter.limit(ctx, owner.name, { key: owner.key, count })).ok)
				throw new Error('Activity quota changed inside its transaction.');
			const existing = await ownerFor(ctx, owner.name, owner.key);
			if (!existing) await ctx.db.insert('buyerActivityQuotaKeys', owner);
			else if (existing.expiresAt - Date.now() < REFILL_MS / 2)
				await ctx.db.replace('buyerActivityQuotaKeys', existing._id, owner);
		})
	);
	return null;
}

/** Essential discussion state has its own component names, owner table and company budget. */
export async function prepareDiscussionQuota(ctx: MutationCtx, link: Link, actorKey: string) {
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
	const checks = await Promise.all(
		owners.map(({ name, key }) => limiter.check(ctx, name, { key }))
	);
	if (checks.some((result) => !result.ok))
		throw new ConvexError('Too many messages. Try again shortly.');
	return {
		work: { documents: 4, bytes: 16_000, queries: 16, readDocuments: 16, readBytes: 32_000 },
		commit: async () => {
			await Promise.all(
				owners.map(async (owner) => {
					if (!(await limiter.limit(ctx, owner.name, { key: owner.key })).ok)
						throw new Error('Discussion quota changed inside its transaction.');
					const existing = await ctx.db
						.query('discussionQuotaKeys')
						.withIndex('by_name_and_key', (q) => q.eq('name', owner.name).eq('key', owner.key))
						.unique();
					if (!existing) await ctx.db.insert('discussionQuotaKeys', owner);
					else if (existing.expiresAt - Date.now() < REFILL_MS / 2)
						await ctx.db.replace('discussionQuotaKeys', existing._id, owner);
				})
			);
		}
	};
}

export async function resetQuota(
	ctx: MutationCtx,
	owner: Doc<'buyerActivityQuotaKeys'> | Doc<'discussionQuotaKeys'>
) {
	await limiter.reset(ctx, owner.name, { key: owner.key });
}

/** Throttled owner writes lag last use by up to half a refill. Preserve that grace before resetting. */
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
					ctx.db
						.query(table)
						.withIndex('by_expiresAt', (q) => q.lte('expiresAt', Date.now() - REFILL_MS / 2)),
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
