'use node';
import { createClerkClient } from '@clerk/backend';
import { v } from 'convex/values';
import { env, internalAction } from './_generated/server';
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';

async function existingUsers(userIds: string[]) {
	try {
		const users = await createClerkClient({ secretKey: env.CLERK_SECRET_KEY }).users.getUserList({
			userId: userIds,
			limit: userIds.length
		});
		const existing = new Set(users.data.map((user) => user.id));
		// Missing IDs are evidence only when the entire requested subset is returned.
		if (
			users.data.length === users.totalCount &&
			existing.size === users.data.length &&
			users.data.every((user) => userIds.includes(user.id))
		)
			return existing;
	} catch {
		// API failures and incomplete responses never establish deletion.
	}
	return null;
}
async function reconcilePage(
	ctx: ActionCtx,
	kind: 'accounts' | 'companies',
	cursor: string | null
) {
	if (!env.CLERK_SECRET_KEY || !env.CLERK_JWT_ISSUER_DOMAIN) return;
	const result = await ctx.runQuery(
		kind === 'accounts' ? internal.accountDeletion.registered : internal.companyDeletion.pending,
		{ cursor }
	);
	const identities = result.page.filter(({ issuer }) => issuer === env.CLERK_JWT_ISSUER_DOMAIN);
	const userIds = [...new Set(identities.map(({ clerkId }) => clerkId))];
	if (userIds.length) {
		const existing = await existingUsers(userIds);
		const missing = existing ? identities.filter(({ clerkId }) => !existing.has(clerkId)) : [];
		if (missing.length) {
			try {
				await ctx.runMutation(internal.accountDeletion.markMany, { identities: missing });
			} catch (error) {
				console.error('Unable to record reconciled account deletions', error);
			}
		}
	}
	// A failed batch must not starve later pages; the next sweep retries it.
	if (!result.done)
		await ctx.scheduler.runAfter(
			0,
			kind === 'accounts' ? internal.clerk.reconcile : internal.clerk.reconcileCompanies,
			{ cursor: result.cursor }
		);
}
export const reconcile = internalAction({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		if (cursor === undefined || cursor === null) {
			await ctx.scheduler.runAfter(0, internal.accountDeletion.resume, {});
			await ctx.scheduler.runAfter(0, internal.companyDeletion.resume, {});
			await ctx.scheduler.runAfter(0, internal.companyDeletion.expirePreparations, {});
			await ctx.scheduler.runAfter(0, internal.clerk.reconcileCompanies, {});
		}
		await reconcilePage(ctx, 'accounts', cursor ?? null);
		return null;
	}
});
export const reconcileCompanies = internalAction({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		// Dispatched company requests remain discoverable after profile cleanup.
		await reconcilePage(ctx, 'companies', cursor ?? null);
		return null;
	}
});
