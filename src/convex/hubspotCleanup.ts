import { v } from 'convex/values';
import type { MutationCtx } from './_generated/server';
import { internalMutation } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { cleanupBudget } from './cleanup';
import { deleteUnownedFile } from './storageOwnership';
import { pool } from './hubspotDelivery';
import type { WorkId } from '@convex-dev/workpool';

export async function retireCompanyHubSpot(ctx: MutationCtx, companyId: Id<'company'>) {
	const budget = cleanupBudget(ctx);
	// Removing credentials first fences every subsequent provider request. In-progress requests have a fixed timeout.
	if (
		!(await budget.drain(
			'hubspotConnections',
			ctx.db
				.query('hubspotConnections')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
		))
	)
		return false;
	if (
		!(await budget.drain(
			'hubspotEvents',
			ctx.db.query('hubspotEvents').withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
			{
				beforeDelete: async (row) => {
					if (row.workId) await pool.cancel(ctx, row.workId as WorkId);
					if (row.leaseUntil && row.leaseUntil + 30_000 > Date.now()) return false;
					return true;
				}
			}
		))
	)
		return false;
	if (
		!(await budget.drain(
			'hubspotExports',
			ctx.db.query('hubspotExports').withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
			{
				afterDelete: async (row) => {
					if (row.fileId) await deleteUnownedFile(ctx, row.fileId);
				}
			}
		))
	)
		return false;
	for (const table of [
		'hubspotLinkBlocks',
		'hubspotExportChunks',
		'hubspotReceiptChunks',
		'hubspotReceipts',
		'hubspotOAuthStates'
	] as const) {
		if (
			!(await budget.drain(
				table,
				ctx.db.query(table).withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			))
		)
			return false;
	}
	return true;
}
export const expireStates = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const rows = await ctx.db
			.query('hubspotOAuthStates')
			.withIndex('by_expiresAt', (q) => q.lte('expiresAt', Date.now()))
			.take(50);
		for (const row of rows) await ctx.db.delete('hubspotOAuthStates', row._id);
		return null;
	}
});
