import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import type { ContractState, SavedSelections } from './saved';
import type { ContractSaveRequest } from './persistence.svelte';
import { readContractState, validSelections, validLifecycles } from './persisted-values';

export type ContractDraft = {
	version: 2;
	base: ContractState;
	choices: SavedSelections;
	lifecycles: Record<string, string>;
	request: ContractSaveRequest | null;
	conflict: boolean;
};
const memory = new Map<string, ContractDraft>();
const volatileKeys = new Set<string>();
const deletedUsers = new Set<string>();
const removedMemberships = new Set<string>();
const prefix = (userId: string) =>
	`dinu:drafts:v2:${encodeURIComponent(env.PUBLIC_CONVEX_URL ?? '')}:${encodeURIComponent(userId)}:`;

function readDraft(value: unknown, id: string): ContractDraft | undefined {
	const draft = value as ContractDraft | null;
	const base = readContractState(draft?.base);
	if (
		base &&
		draft?.version === 2 &&
		typeof draft.conflict === 'boolean' &&
		validSelections(draft.choices) &&
		validLifecycles(draft.lifecycles) &&
		(draft.request === null ||
			(draft.request?.id === id &&
				Number.isSafeInteger(draft.request.expectedRevision) &&
				draft.request.expectedRevision >= 0 &&
				typeof draft.request.operationId === 'string' &&
				draft.request.operationId.trim().length > 0 &&
				draft.request.operationId.length <= 200 &&
				validSelections(draft.request.selectedConcessions) &&
				validLifecycles(draft.request.selectionLifecycles)))
	)
		return { ...draft, base };
}

/** Recovery is separate from the optional, server-confirmed snapshot cache. */
export class DraftJournal {
	memoryOnly = $state(false);
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
	read(): ContractDraft | null {
		if (!browser || deletedUsers.has(this.userId) || removedMemberships.has(this.namespace))
			return null;
		this.memoryOnly = volatileKeys.has(this.key);
		if (memory.has(this.key)) return structuredClone(memory.get(this.key)!);
		try {
			const value = readDraft(
				JSON.parse(sessionStorage.getItem(this.key) ?? 'null'),
				this.contractId
			);
			if (value) {
				memory.set(this.key, value);
				return structuredClone(value);
			}
		} catch {
			this.memoryOnly = true;
			volatileKeys.add(this.key);
		}
		return null;
	}
	write(draft: ContractDraft | null) {
		if (!browser || deletedUsers.has(this.userId) || removedMemberships.has(this.namespace)) return;
		if (draft) memory.set(this.key, structuredClone(draft));
		else memory.delete(this.key);
		try {
			if (draft) sessionStorage.setItem(this.key, JSON.stringify(draft));
			else sessionStorage.removeItem(this.key);
			this.memoryOnly = false;
			volatileKeys.delete(this.key);
		} catch {
			this.memoryOnly = true;
			volatileKeys.add(this.key);
			// Remove a stale checkpoint when a replacement cannot be persisted.
			try {
				sessionStorage.removeItem(this.key);
			} catch {
				/* Storage unavailable. */
			}
		}
	}
}

/** Discover intent before account-level flushing can decide that the workspace is clean. */
export type DraftRecovery = { id: string; journal: DraftJournal; draft: ContractDraft };

export function discoverContractDrafts(userId: string, membershipId: string): DraftRecovery[] {
	const namespace = prefix(userId) + encodeURIComponent(membershipId) + ':';
	if (!browser || deletedUsers.has(userId) || removedMemberships.has(namespace)) return [];
	const keys = new Set([...memory.keys()].filter((key) => key.startsWith(namespace)));
	try {
		for (let i = 0; i < sessionStorage.length; i++) {
			const key = sessionStorage.key(i);
			if (key?.startsWith(namespace)) keys.add(key);
		}
	} catch {
		/* Memory remains usable when storage is unavailable. */
	}
	const records: DraftRecovery[] = [];
	for (const key of keys) {
		try {
			const id = decodeURIComponent(key.slice(namespace.length));
			if (!id) continue;
			const journal = new DraftJournal(userId, id, membershipId);
			const draft = journal.read();
			if (draft) records.push({ id, journal, draft });
		} catch {
			/* Ignore invalid keys and checkpoints. */
		}
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
	for (const key of volatileKeys) if (key.startsWith(namespace)) volatileKeys.delete(key);
	if (!browser) return;
	try {
		for (let i = sessionStorage.length - 1; i >= 0; i--) {
			const key = sessionStorage.key(i);
			if (key?.startsWith(namespace)) sessionStorage.removeItem(key);
		}
	} catch {
		/* This namespace remains invalidated even when storage is unavailable. */
	}
}
