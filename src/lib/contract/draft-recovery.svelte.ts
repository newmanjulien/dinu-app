import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import { readDraft, type ContractDraft } from './draft-values';
export type { ContractDraft } from './draft-values';

const memory = new Map<string, ContractDraft | null>();
const deletedUsers = new Set<string>();
const removedMemberships = new Set<string>();
type DraftOwner = { flush: () => Promise<boolean>; hasLocalIntent: () => boolean };
const owners = new Map<string, DraftOwner>();
const prefix = (userId: string) =>
	`dinu:drafts:v7:${encodeURIComponent(env.PUBLIC_CONVEX_URL ?? '')}:${encodeURIComponent(userId)}:`;

/** Lightweight sessionStorage draft backup for unsaved contract selections. */
export class DraftJournal {
	private key: string;
	private namespace: string;
	constructor(
		private userId: string,
		private contractId: string,
		membershipId: string
	) {
		this.namespace = prefix(userId) + encodeURIComponent(membershipId) + ':';
		this.key = this.namespace + encodeURIComponent(contractId);
	}
	registerOwner(owner: DraftOwner) {
		owners.set(this.key, owner);
		return () => {
			if (owners.get(this.key) === owner) owners.delete(this.key);
		};
	}
	get owner() {
		return owners.get(this.key);
	}
	get hasStoredIntent() {
		return Boolean(this.read());
	}
	read(): ContractDraft | null {
		if (!browser || deletedUsers.has(this.userId) || removedMemberships.has(this.namespace))
			return null;
		if (memory.has(this.key)) return structuredClone(memory.get(this.key)!);
		try {
			const stored = sessionStorage.getItem(this.key);
			const value = readDraft(JSON.parse(stored ?? 'null'), this.contractId);
			if (value) {
				memory.set(this.key, value);
				return structuredClone(value);
			}
			if (stored) sessionStorage.removeItem(this.key);
		} catch {
			/* Storage unavailable or unreadable. */
		}
		return null;
	}
	discard() {
		this.write(null);
	}
	write(draft: ContractDraft | null) {
		if (!browser || deletedUsers.has(this.userId) || removedMemberships.has(this.namespace)) return;
		memory.set(this.key, draft ? structuredClone(draft) : null);
		try {
			if (draft) sessionStorage.setItem(this.key, JSON.stringify(draft));
			else sessionStorage.removeItem(this.key);
		} catch {
			/* Storage unavailable; memory map retains current draft. */
		}
	}
}

export type DraftRecovery = { id: string; journal: DraftJournal; draft: ContractDraft | null };

export function discoverContractDrafts(userId: string, membershipId: string): DraftRecovery[] {
	const namespace = prefix(userId) + encodeURIComponent(membershipId) + ':';
	if (!browser || deletedUsers.has(userId) || removedMemberships.has(namespace)) return [];
	const ids = new Set<string>();
	const collect = (key: string | null) => {
		if (!key?.startsWith(namespace)) return;
		const encoded = key.slice(namespace.length);
		if (!encoded || encoded.includes(':')) return;
		try {
			ids.add(decodeURIComponent(encoded));
		} catch {
			/* Invalid key cannot be replayed. */
		}
	};
	for (const key of memory.keys()) collect(key);
	try {
		for (let i = 0; i < sessionStorage.length; i++) collect(sessionStorage.key(i));
	} catch {
		/* Memory remains usable. */
	}
	const records: DraftRecovery[] = [];
	for (const id of ids) {
		const journal = new DraftJournal(userId, id, membershipId);
		const draft = journal.read();
		if (draft) records.push({ id, journal, draft });
	}
	return records;
}

export function discardUserDrafts(userId: string) {
	deletedUsers.add(userId);
	discardNamespace(prefix(userId));
}

export function discardMembershipDrafts(userId: string, membershipId: string) {
	const namespace = prefix(userId) + encodeURIComponent(membershipId) + ':';
	removedMemberships.add(namespace);
	discardNamespace(namespace);
}

function discardNamespace(namespace: string) {
	for (const key of memory.keys()) if (key.startsWith(namespace)) memory.delete(key);
	if (!browser) return;
	try {
		for (let i = sessionStorage.length - 1; i >= 0; i--) {
			const key = sessionStorage.key(i);
			if (key?.startsWith(namespace)) sessionStorage.removeItem(key);
		}
	} catch {
		/* Namespace remains invalidated. */
	}
}
