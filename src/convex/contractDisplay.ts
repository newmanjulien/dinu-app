import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from '../lib/document/canonical-json';
import type { Doc } from './_generated/dataModel';

/** The exact wording, title and frozen explanation source shown to a viewer. */
export function displayIdentity(
	root: Pick<
		Doc<'savedContracts'>,
		'documentId' | 'documentRevision' | 'title' | 'templateVersionId'
	>,
	fingerprint: string
) {
	return bytesToHex(
		sha256(
			new TextEncoder().encode(
				canonicalJson([
					root.documentId,
					root.documentRevision,
					fingerprint,
					root.title,
					root.templateVersionId
				])
			)
		)
	);
}
