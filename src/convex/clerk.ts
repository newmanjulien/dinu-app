'use node';
import { createClerkClient } from '@clerk/backend';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import { env, internalAction } from './_generated/server';
import { ACCOUNT_DELETION_BATCH_SIZE, CLERK_USER_BATCH_SIZE } from './deletionPolicy';

async function existingUsers(userIds: string[]) {
	try {
		const users = await createClerkClient({ secretKey: env.CLERK_SECRET_KEY }).users.getUserList({
			userId: userIds,
			limit: userIds.length
		});
		const existing = new Set(users.data.map((user) => user.id));
		const requested = new Set(userIds);
		// Missing IDs are evidence only when the entire requested subset is returned.
		if (
			users.data.length === users.totalCount &&
			existing.size === users.data.length &&
			users.data.every((user) => requested.has(user.id))
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
	const issuer = env.CLERK_JWT_ISSUER_DOMAIN;
	if (!env.CLERK_SECRET_KEY || !issuer) return;
	const result = await ctx.runQuery(
		kind === 'accounts' ? internal.accountDeletion.registered : internal.companyDeletion.pending,
		{ cursor }
	);
	const identities = result.page.filter((identity) => identity.issuer === issuer);
	const userIds = [...new Set(identities.map(({ clerkId }) => clerkId))];
	// Native pagination targets are not provider limits. Bound every request independently.
	for (let i = 0; i < userIds.length; i += CLERK_USER_BATCH_SIZE) {
		const batch = userIds.slice(i, i + CLERK_USER_BATCH_SIZE);
		const existing = await existingUsers(batch);
		if (!existing) continue;
		const missing = batch
			.filter((clerkId) => !existing.has(clerkId))
			.map((clerkId) => ({ issuer, clerkId }));
		// Keep each canonical marker transaction at its existing smaller write bound.
		for (let j = 0; j < missing.length; j += ACCOUNT_DELETION_BATCH_SIZE) {
			try {
				await ctx.runMutation(internal.accountDeletion.markMany, {
					identities: missing.slice(j, j + ACCOUNT_DELETION_BATCH_SIZE)
				});
			} catch (error) {
				console.error('Unable to record reconciled account deletions', error);
			}
		}
	}
	// A failed batch must not starve later pages; the next sweep retries it.
	if (!result.isDone)
		await ctx.scheduler.runAfter(
			0,
			kind === 'accounts' ? internal.clerk.reconcile : internal.clerk.reconcileCompanies,
			{ cursor: result.continueCursor }
		);
}
export const reconcile = internalAction({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		if (cursor === undefined || cursor === null) {
			try {
				await ctx.runMutation(internal.recovery.resume, {});
			} catch (error) {
				console.error('Unable to discover local recovery work', error);
			}
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
