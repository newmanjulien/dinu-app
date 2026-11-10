import { ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';

export async function installation(ctx: QueryCtx, companyId: Id<'company'>) {
	const row = await ctx.db
		.query('hubspotConnections')
		.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
		.unique();
	return row?.status === 'retiring' ? null : row;
}

export function lifecycle(ctx: QueryCtx, companyId: Id<'company'>) {
	return ctx.db
		.query('hubspotLifecycles')
		.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
		.unique();
}

export function portalLifecycle(ctx: QueryCtx, accountId: string) {
	return ctx.db
		.query('hubspotPortalLifecycle')
		.withIndex('by_accountId', (q) => q.eq('accountId', accountId))
		.unique();
}

export async function activeDestination(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	destination: Doc<'hubspotExports'>['destination']
) {
	if (!destination) return null;
	const row = await ctx.db.get('hubspotConnections', destination.connectionId);
	return row &&
		row.status !== 'retiring' &&
		row.companyId === companyId &&
		row.accountId === destination.accountId
		? row
		: null;
}

export async function otherAttachments(ctx: QueryCtx, accountId: string, companyId: Id<'company'>) {
	// Two rows suffice: at most one current connection belongs to this company.
	for (const status of ['connected', 'reconnect'] as const) {
		const rows = await ctx.db
			.query('hubspotConnections')
			.withIndex('by_accountId_and_status', (q) =>
				q.eq('accountId', accountId).eq('status', status)
			)
			.take(2);
		if (rows.some((row) => row.companyId !== companyId)) return true;
	}
	return false;
}

export async function requireInstallAllowed(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	accountId?: string
) {
	const state = await lifecycle(ctx, companyId);
	const removal = state?.removalId ? await ctx.db.get('hubspotRemovals', state.removalId) : null;
	const provider = removal ? await ctx.db.get('hubspotAccountRemovals', removal.providerId) : null;
	if (removal && (!removal.done || provider?.blocking))
		throw new ConvexError(
			'HubSpot removal is still being resolved. Check its status before installing.'
		);
	if (accountId) {
		const locked = await ctx.db
			.query('hubspotAccountRemovals')
			.withIndex('by_accountId_and_blocking', (q) =>
				q.eq('accountId', accountId).eq('blocking', true)
			)
			.first();
		if (locked) throw new ConvexError('HubSpot removal is still being resolved for this account.');
	}
	return state;
}
