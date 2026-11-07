import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import type { ActivityCommand } from './activity-commands';
import type { ApplicationChoices } from './applications';
import { readContractState, validChoices } from './persisted-values';
import type { RetainedSaveRequest } from './persistence.svelte';
import type { ContractState } from './saved';

export type ContractDraft = {
	version: 4 | 5 | 6;
	commands?: ActivityCommand[];
	base: ContractState;
	intent: ApplicationChoices;
	request: RetainedSaveRequest | null;
	conflict: boolean;
};
const memory = new Map<string, ContractDraft | null>();
const volatileKeys = new Set<string>();
const deletedUsers = new Set<string>();
const removedMemberships = new Set<string>();
const prefix = (userId: string) =>
	`dinu:drafts:v4:${encodeURIComponent(env.PUBLIC_CONVEX_URL ?? '')}:${encodeURIComponent(userId)}:`;

function validCommands(value: unknown): value is ActivityCommand[] {
	return (
		Array.isArray(value) &&
		value.length <= 250 &&
		value.every(
			(c) =>
				c &&
				typeof c.id === 'string' &&
				c.id.length > 0 &&
				c.id.length <= 200 &&
				typeof c.itemId === 'string' &&
				typeof c.occurredAt === 'number' &&
				Number.isFinite(c.occurredAt) &&
				(c.choice === null || validChoices({ [c.itemId]: c.choice }))
		)
	);
}
function readDraft(value: unknown, id: string): ContractDraft | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return;
	if (
		Object.keys(value).some(
			(key) => !['version', 'base', 'intent', 'request', 'conflict', 'commands'].includes(key)
		)
	)
		return;
	const draft = value as ContractDraft;
	const base = readContractState(draft?.base);
	if (
		base &&
		(draft?.version === 4 || draft?.version === 5 || draft?.version === 6) &&
		typeof draft.conflict === 'boolean' &&
		(draft.version !== 6 ||
			(validCommands(draft.commands) &&
				(draft.request === null || validCommands(draft.request?.commands)))) &&
		validChoices(draft.intent) &&
		(draft.commands === undefined || validCommands(draft.commands)) &&
		(draft.request?.commands === undefined || validCommands(draft.request.commands)) &&
		(draft.request === null ||
			(typeof draft.request === 'object' &&
				!Array.isArray(draft.request) &&
				Object.keys(draft.request).every((key) =>
					['id', 'choices', 'expectedEditRevision', 'operationId', 'commands'].includes(key)
				) &&
				draft.request.id === id &&
				Number.isSafeInteger(draft.request.expectedEditRevision) &&
				draft.request.expectedEditRevision >= 0 &&
				typeof draft.request.operationId === 'string' &&
				draft.request.operationId.trim().length > 0 &&
				draft.request.operationId.length <= 200 &&
				validChoices(draft.request.choices)))
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
			const stored = sessionStorage.getItem(this.key);
			const value = readDraft(JSON.parse(stored ?? 'null'), this.contractId);
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
		memory.set(this.key, draft ? structuredClone(draft) : null);
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
