import { beforeEach } from 'vitest';
import { createOperationId, parseOperationId } from '../../src/lib/contract/operation-identity';

const identities = new Map<string, string>();
beforeEach(() => identities.clear());

/** Stable protocol identities for existing replay fixtures within each test. */
export function fixtureOperationId(label: string): string {
	if (parseOperationId(label)) return label;
	let identity = identities.get(label);
	if (!identity) {
		identity = createOperationId();
		identities.set(label, identity);
	}
	return identity;
}
