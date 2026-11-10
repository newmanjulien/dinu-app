import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { ExportBlock } from './content';

/** Literal legal labels count; exporter-only numbering identities do not. */
export function quoteSemanticIdentity(
	source: {
		companyId: string;
		contractId: string;
		accountId: string;
		dealId: string;
		title: string;
	},
	blocks: readonly ExportBlock[]
) {
	const hash = (value: string) => bytesToHex(sha256(utf8ToBytes(value)));
	const fingerprint = hash(
		JSON.stringify([
			source.title,
			blocks.map((block) =>
				block.kind === 'table'
					? ['table', block.headerRowCount, block.rows]
					: [block.role, block.content]
			)
		])
	);
	return {
		fingerprint,
		canonicalKey: hash(
			JSON.stringify([
				source.companyId,
				source.contractId,
				source.accountId,
				source.dealId,
				fingerprint
			])
		)
	};
}
