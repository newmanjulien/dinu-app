import type { AppliedConcessions } from '../lib/contract/applications';
import type { Id } from './_generated/dataModel';

/** Complete immutable provenance, in original iteration order. No current-contract reads. */
type Entry = [string, string, [string, 'pending' | 'approved' | 'rejected'] | null];
export function encodeProvenance(applications: AppliedConcessions) {
	return JSON.stringify(
		Object.entries(applications).map(([item, value]): Entry => [
			item,
			value.concessionId,
			value.approval ? [value.approval.applicationId, value.approval.status] : null
		])
	);
}
export function decodeProvenance(data: string): AppliedConcessions {
	const entries = JSON.parse(data) as Entry[];
	return Object.fromEntries(
		entries.map(([item, concessionId, approval]) => [
			item as Id<'playbookItems'>,
			{
				concessionId,
				...(approval ? { approval: { applicationId: approval[0], status: approval[1] } } : {})
			}
		])
	);
}

/** Byte-bounded native documents; don't split a surrogate pair across stored strings. */
export function provenanceChunks(data: string) {
	const encoder = new TextEncoder(),
		chunks: string[] = [];
	for (let offset = 0; offset < data.length;) {
		let end = Math.min(data.length, offset + 120 * 1024);
		while (encoder.encode(data.slice(offset, end)).length > 120 * 1024)
			end = offset + Math.floor((end - offset) * 0.8);
		if (end < data.length && /[\uDC00-\uDFFF]/.test(data[end])) end--;
		chunks.push(data.slice(offset, end));
		offset = end;
		if (chunks.length > 63) throw new Error('Download provenance exceeds its storage envelope.');
	}
	return chunks;
}
