import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import { readDraft, type ContractDraft } from './draft-values';
export type { ContractDraft } from './draft-values';

type DraftOwner = { flush: () => Promise<boolean>; hasLocalIntent: () => boolean };
type UserDrafts = {
	active: boolean;
	storageReadable: boolean;
	memory: Map<string, ContractDraft | null>;
	owners: Map<string, DraftOwner>;
};
const users = new Map<string, UserDrafts>();
const prefix = (userId: string) =>
	`dinu:drafts:v7:${encodeURIComponent(env.PUBLIC_CONVEX_URL ?? '')}:${encodeURIComponent(userId)}:`;

function userDrafts(userId: string): UserDrafts {
	let user = users.get(userId);
	if (!user) {
		user = { active: true, storageReadable: true, memory: new Map(), owners: new Map() };
		users.set(userId, user);
	}
	return user;
}

/** Lightweight sessionStorage draft backup for unsaved contract selections. */
export class DraftJournal {
	private key: string;
	private user: UserDrafts;
	constructor(
		userId: string,
		private contractId: string,
		membershipId: string
	) {
		this.user = userDrafts(userId);
		this.key =
			prefix(userId) + encodeURIComponent(membershipId) + ':' + encodeURIComponent(contractId);
	}
	private get active() {
		return this.user.active;
	}
	registerOwner(owner: DraftOwner) {
		if (this.active) this.user.owners.set(this.key, owner);
		return () => {
			if (this.user.owners.get(this.key) === owner) this.user.owners.delete(this.key);
		};
	}
	get owner() {
		return this.active ? this.user.owners.get(this.key) : undefined;
	}
	get hasStoredIntent() {
		return Boolean(this.read());
	}
	read(): ContractDraft | null {
		if (!browser || !this.active) return null;
		if (this.user.memory.has(this.key)) return structuredClone(this.user.memory.get(this.key)!);
		if (!this.user.storageReadable) return null;
		try {
			const stored = sessionStorage.getItem(this.key);
			const value = readDraft(JSON.parse(stored ?? 'null'), this.contractId);
			if (value) {
				this.user.memory.set(this.key, value);
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
		if (!browser || !this.active) return;
		this.user.memory.set(this.key, draft ? structuredClone(draft) : null);
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
	if (!browser) return [];
	const user = userDrafts(userId);
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
	for (const key of user.memory.keys()) collect(key);
	try {
		if (user.storageReadable)
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
	const user = users.get(userId);
	if (user) {
		user.active = false;
		user.memory.clear();
		user.owners.clear();
	}
	users.delete(userId);
	if (!discardNamespace(prefix(userId))) {
		// A returning user may create new intent, but cannot recover the failed purge's records.
		userDrafts(userId).storageReadable = false;
	}
}

/** Capture before an async exit; a retired owner cannot clear a replacement's drafts. */
export function captureUserDraftCleanup(userId: string): () => void {
	const user = userDrafts(userId);
	return () => {
		if (user.active) discardUserDrafts(userId);
	};
}

function discardNamespace(namespace: string): boolean {
	if (!browser) return true;
	const keys: string[] = [];
	try {
		for (let i = 0; i < sessionStorage.length; i++) {
			const key = sessionStorage.key(i);
			if (key?.startsWith(namespace)) keys.push(key);
		}
	} catch {
		return false;
	}
	let removed = true;
	for (const key of keys) {
		try {
			sessionStorage.removeItem(key);
		} catch {
			removed = false;
		}
	}
	return removed;
}
