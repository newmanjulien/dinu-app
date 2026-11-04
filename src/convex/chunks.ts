import { getConvexSize, getDocumentSize, type Value } from 'convex/values';
import {
	MAX_STORAGE_ARRAY_ENTRIES,
	MAX_STORAGE_DOCUMENT_BYTES
} from '../lib/contract/storage-limits';

export const CHUNK_TARGET_BYTES = 128 * 1024;
// Read one sentinel row beyond the supported envelope of at most 31 chunks.
export const CHUNK_READ_LIMIT = 32;

/** Pack complete wrappers; an entry above the target occupies a native-size row alone. */
export function chunkEntries<Entry extends Value>(
	entries: Entry[],
	wrap: (entries: Entry[]) => Record<string, Value>,
	entryError: string
): Entry[][] {
	const overhead = getDocumentSize(wrap([]));
	const result: Entry[][] = [];
	let current: Entry[] = [];
	let bytes = overhead;
	for (const entry of entries) {
		const size = getConvexSize(entry);
		if (overhead + size > MAX_STORAGE_DOCUMENT_BYTES) throw new Error(entryError);
		if (
			current.length &&
			(bytes + size > CHUNK_TARGET_BYTES || current.length === MAX_STORAGE_ARRAY_ENTRIES)
		) {
			result.push(current);
			current = [];
			bytes = overhead;
		}
		current.push(entry);
		bytes += size;
	}
	if (current.length) result.push(current);
	return result;
}
