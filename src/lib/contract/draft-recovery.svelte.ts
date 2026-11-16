import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import { readDraft, type ContractDraft } from './draft-values';
export type { ContractDraft } from './draft-values';

const memory = new Map<string, ContractDraft | null>();
const blockedOriginals = new Map<string, string>();
const volatileKeys = new Set<string>();
const deletedUsers = new Set<string>();
const removedMemberships = new Set<string>();
type DraftOwner = { flush: () => Promise<boolean>; hasLocalIntent: () => boolean };
const owners = new Map<string, DraftOwner>();
const prefix = (userId: string) =>
	`dinu:drafts:v6:${encodeURIComponent(env.PUBLIC_CONVEX_URL ?? '')}:${encodeURIComponent(userId)}:`;

/** Current-schema intent is durable and separate from disposable confirmed caches. */
export class DraftJournal {
	memoryOnly = $state(false);
	recoveryError = $state<string | null>(null);
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
		return Boolean(this.read() || this.recoveryError || this.memoryOnly);
	}
	read(): ContractDraft | null {
		if (!browser || deletedUsers.has(this.userId) || removedMemberships.has(this.namespace))
			return null;
		this.memoryOnly = volatileKeys.has(this.key);
		if (blockedOriginals.has(this.key)) {
			this.recoveryError =
				'Your stored selections need review. The original data is still stored in this browser.';
			return null;
		}
		if (memory.has(this.key)) return structuredClone(memory.get(this.key)!);
		let stored: string | null = null;
		try {
			stored = sessionStorage.getItem(this.key);
			const value = readDraft(JSON.parse(stored ?? 'null'), this.contractId);
			this.recoveryError =
				stored && !value
					? 'Your saved draft could not be read. Your changes are still stored in this browser.'
					: null;
			if (stored && !value) blockedOriginals.set(this.key, stored);
			if (value) {
				memory.set(this.key, value);
				return structuredClone(value);
			}
		} catch (error) {
			if (stored) blockedOriginals.set(this.key, stored);
			if (error instanceof SyntaxError)
				this.recoveryError =
					'Your saved draft could not be read. Your changes are still stored in this browser.';
			this.memoryOnly = true;
			volatileKeys.add(this.key);
		}
		return null;
	}
	downloadRecovery() {
		if (!browser) return;
		let raw: string | null = blockedOriginals.get(this.key) ?? null;
		if (!raw && memory.has(this.key)) raw = JSON.stringify(memory.get(this.key));
		else if (!raw) {
			try {
				raw = sessionStorage.getItem(this.key);
			} catch {
				/* Storage unavailable. */
			}
		}
		if (!raw) return;
		const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = 'contract-selections-recovery.json';
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
	discard() {
		blockedOriginals.delete(this.key);
		this.recoveryError = null;
		this.write(null);
	}
	discardAll() {
		this.discard();
	}
	write(draft: ContractDraft | null) {
		if (
			!browser ||
			deletedUsers.has(this.userId) ||
			removedMemberships.has(this.namespace) ||
			this.recoveryError ||
			blockedOriginals.has(this.key)
		)
			return;
		memory.set(this.key, draft ? structuredClone(draft) : null);
		if (!draft) this.recoveryError = null;
		try {
			if (draft) sessionStorage.setItem(this.key, JSON.stringify(draft));
			else sessionStorage.removeItem(this.key);
			this.memoryOnly = false;
			volatileKeys.delete(this.key);
		} catch {
			this.memoryOnly = true;
			volatileKeys.add(this.key);
			// A stale checkpoint must not replay after a newer memory-only replacement.
			try {
				sessionStorage.removeItem(this.key);
			} catch {
				/* Storage unavailable. */
			}
		}
	}
}

export type DraftRecovery = { id: string; journal: DraftJournal; draft: ContractDraft | null };
/** Discover only the post-reset namespace before account exit can report a clean workspace. */
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
	for (const key of blockedOriginals.keys()) collect(key);
	try {
		for (let i = 0; i < sessionStorage.length; i++) collect(sessionStorage.key(i));
	} catch {
		/* Memory remains usable. */
	}
	const records: DraftRecovery[] = [];
	for (const id of ids) {
		const journal = new DraftJournal(userId, id, membershipId);
		const draft = journal.read();
		if (draft || journal.recoveryError || journal.memoryOnly) records.push({ id, journal, draft });
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
	for (const key of blockedOriginals.keys())
		if (key.startsWith(namespace)) blockedOriginals.delete(key);
	for (const key of volatileKeys) if (key.startsWith(namespace)) volatileKeys.delete(key);
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
