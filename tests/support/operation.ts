import { beforeEach } from 'vitest';

const identities = new Map<string, string>();
beforeEach(() => identities.clear());

/** Stable protocol identities for existing replay fixtures within each test. */
export function fixtureOperationId(label: string): string {
	let identity = identities.get(label);
	if (!identity) {
		identity = crypto.randomUUID();
		identities.set(label, identity);
	}
	return identity;
}
