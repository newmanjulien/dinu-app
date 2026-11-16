import type { MutationCtx } from './_generated/server';
import type { Doc, TableNames } from './_generated/dataModel';

export const CLEANUP_DISCOVERY_PAGE_SIZE = 10;

/** One transaction budget, including nested children and job cancellation. */
export function cleanupBudget(ctx: MutationCtx) {
	let count = 0;
	async function exhausted() {
		const metrics = await ctx.meta.getTransactionMetrics();
		// Leave room for a full-size next row, cancellation, marker progress,
		// and one continuation. These are reserves, not application limits.
		return (
			count >= 100 ||
			metrics.bytesRead.remaining < 4_000_000 ||
			metrics.bytesWritten.remaining < 4_000_000 ||
			metrics.databaseQueries.remaining < 64 ||
			metrics.documentsRead.remaining < 64 ||
			metrics.documentsWritten.remaining < 64 ||
			metrics.functionsScheduled.remaining < 1 ||
			metrics.scheduledFunctionArgsBytes.remaining < 1024
		);
	}
	async function drain<Table extends TableNames>(
		table: Table,
		rows: AsyncIterable<Doc<Table>>,
		hooks?: {
			beforeDelete?: (row: Doc<Table>) => Promise<boolean | void>;
			afterDelete?: (row: Doc<Table>) => Promise<void>;
		}
	) {
		if (await exhausted()) return false;
		for await (const row of rows) {
			if ((await hooks?.beforeDelete?.(row)) === false) return false;
			await ctx.db.delete(table, row._id);
			await hooks?.afterDelete?.(row);
			count++;
			if (await exhausted()) return false;
		}
		return true;
	}
	return { exhausted, drain };
}
