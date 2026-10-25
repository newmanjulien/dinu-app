import { ConvexError, getDocumentSize, type Value } from 'convex/values';
import type { MutationCtx } from './_generated/server';

export const MAX_SNAPSHOT_BYTES = 8_000_000;
const RESERVE_BYTES = 65_536;
export function publicationRejected(message: string) {
	return new ConvexError({ code: 'TEMPLATE_PUBLICATION_REJECTED', message });
}
export function documentBytes(document: Record<string, Value | undefined>) {
	const bytes = getDocumentSize(
		Object.fromEntries(
			Object.entries(document).filter((entry): entry is [string, Value] => entry[1] !== undefined)
		)
	);
	if (bytes > 1024 * 1024)
		throw publicationRejected('A template storage document exceeds supported size.');
	return bytes;
}
/** Each write group checks what remains after all preceding caller work. */
export async function publicationCapacity(
	ctx: MutationCtx,
	work: {
		documents?: number;
		bytes?: number;
		queries?: number;
		readDocuments?: number;
		readBytes?: number;
	}
) {
	const metrics = await ctx.meta.getTransactionMetrics();
	if (
		metrics.documentsWritten.remaining < (work.documents ?? 0) + 2 ||
		metrics.bytesWritten.remaining < (work.bytes ?? 0) + RESERVE_BYTES ||
		metrics.databaseQueries.remaining < (work.queries ?? 0) ||
		metrics.documentsRead.remaining < (work.readDocuments ?? 0) ||
		metrics.bytesRead.remaining < (work.readBytes ?? 0) + RESERVE_BYTES
	)
		throw publicationRejected(
			'Template publication exceeds transaction capacity. Reduce the template size.'
		);
}
