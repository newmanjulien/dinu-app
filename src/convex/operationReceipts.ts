import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { CompanyAccess } from './auth';
import { cleanupBudget } from './cleanup';

export const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 256;

export function validateOperationId(id: string) {
	const value = id.trim();
	if (!value || value !== id || value.length > 200)
		throw new ConvexError({ code: 'OPERATION_INVALID', message: 'Invalid operation identity.' });
	return value;
}

export function scopedKey(scope: string, kind: string, id: string) {
	validateOperationId(id);
	return JSON.stringify([scope, kind, id]);
}

export function actionKey(access: CompanyAccess, kind: string, id: string) {
	return scopedKey(access.membershipId, kind, id);
}

export function actorOf(profile: Pick<Doc<'profiles'>, 'name' | 'email'>) {
	return { name: profile.name, email: profile.email };
}

export async function sha256(value: string) {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
		(b) => b.toString(16).padStart(2, '0')
	).join('');
}

export async function receipt(ctx: QueryCtx, key: string, inputs: string) {
	const row = await ctx.db
		.query('operationReceipts')
		.withIndex('by_key', (q) => q.eq('key', key))
		.unique();
	if (row && row.inputs !== inputs)
		throw new ConvexError('This operation was already used with different inputs.');
	return row;
}

export async function remember(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	key: string,
	inputs: string,
	result: string,
	contractId?: Id<'savedContracts'>
) {
	return ctx.db.insert('operationReceipts', {
		companyId,
		...(contractId ? { contractId } : {}),
		key,
		inputs,
		result,
		expiresAt: Date.now() + RECEIPT_TTL_MS
	});
}

/**
 * Called only by company erasure; individual contract deletion leaves 24h receipts in place so
 * `contracts.create`, `hubspotDeals`, and `hubspotQuotes` (which read receipts before contract
 * existence) keep their replay fences until TTL expiry.
 */
export async function cleanupCompanyOperations(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	{ drain } = cleanupBudget(ctx)
) {
	return drain(
		'operationReceipts',
		ctx.db.query('operationReceipts').withIndex('by_companyId', (q) => q.eq('companyId', companyId))
	);
}

/** Daily TTL maintenance for operation receipts. */
export const pruneExpired = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		const expiredOps = await ctx.db
			.query('operationReceipts')
			.withIndex('by_expiresAt', (q) => q.lt('expiresAt', now))
			.take(PRUNE_BATCH);
		for (const row of expiredOps) await ctx.db.delete('operationReceipts', row._id);

		if (expiredOps.length === PRUNE_BATCH)
			await ctx.scheduler.runAfter(0, internal.operationReceipts.pruneExpired, {});
		return null;
	}
});
