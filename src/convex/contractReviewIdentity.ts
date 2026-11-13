import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalJson } from '../lib/document/canonical-json';
import type { ApprovalContext } from '../lib/contract/changes';

export const contextIdentity = (value: unknown) =>
	bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))));
export const initialContextIdentity = (contractId: string, context: ApprovalContext) =>
	contextIdentity(['contract-review', contractId, context]);

/** Semantic change clears the previous notification owner. Admin decisions expose
 * the existing optional confirmation only when the exact review set is complete. */
export function changedContextCompletion(
	reviewIdentity: string,
	count: number,
	pendingCount: number,
	access: import('./auth').CompanyAccess
) {
	return access.membership.role === 'admin' && count > 0 && pendingCount === 0
		? {
				reviewIdentity,
				completion: { kind: 'awaitingConfirmation' as const, reviewerId: access.profile._id }
			}
		: undefined;
}
