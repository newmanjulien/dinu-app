import { SvelteMap } from 'svelte/reactivity';
import { getContext, setContext } from 'svelte';
import type { Infer } from 'convex/values';
import { validate } from 'convex-helpers/validators';
import { env } from '$env/dynamic/public';
import { parseOperationId } from '../contract/operation-identity';
import { discussionCommand, type DiscussionAnchor } from './validators';
import type { Id } from '../../convex/_generated/dataModel';

type ComposerWork = {
	id: string;
	authorKey: string | null;
	account: boolean | null;
	text: string;
	open: boolean;
	busy: boolean;
	error: string | null;
};
export type CreateTarget = {
	anchor: DiscussionAnchor;
	type: 'comment' | 'proposal';
	revision: number;
	contentIdentity: string;
};
export type CreateComposerState = ComposerWork &
	CreateTarget & { kind: 'create'; deleteSelectedWording: boolean };
export type ReplyComposerState = ComposerWork & {
	kind: 'reply';
	threadId: Id<'discussionThreads'>;
};
export type EditComposerState = ComposerWork & {
	kind: 'edit';
	messageId: Id<'discussionMessages'>;
	threadId?: Id<'discussionThreads'>;
	deleteSelectedWording: boolean;
	initialized: boolean;
	expected: number;
};
export type DiscussionOperation = {
	id: string;
	source: string;
	authorKey: string;
	readonly account: boolean;
	uncertain: boolean;
	blocked?: boolean;
	threadId?: Id<'discussionThreads'>;
	readonly command: Infer<typeof discussionCommand>;
};

/** Unsent composer text is intentionally discarded on collapse or remount; submitted operations persist. */
export class DiscussionWork {
	composer = $state<CreateComposerState | null>(null);
	readonly operations = new SvelteMap<string, DiscussionOperation>();
	readonly created = new SvelteMap<string, Id<'discussionThreads'>>();
	readonly replies = new SvelteMap<string, ReplyComposerState>();
	readonly edits = new SvelteMap<string, EditComposerState>();
	setText(composer: CreateComposerState | ReplyComposerState | EditComposerState, text: string) {
		composer.text = text;
	}
	setDeletion(composer: CreateComposerState | EditComposerState, deleting: boolean) {
		composer.deleteSelectedWording = deleting;
	}
	destroy() {
		this.composer = null;
		this.operations.clear();
		this.created.clear();
		this.replies.clear();
		this.edits.clear();
	}
}

type StoredOperations = {
	version: 2;
	operations: DiscussionOperation[];
	created: [string, Id<'discussionThreads'>][];
};
const contextKey = Symbol('discussion-recovery');
const memory = new Map<string, string>();
const latestClaim = new Map<string, symbol>();
const workClaims = new WeakMap<DiscussionWork, Map<string, symbol>>();
const maxStoredLength = 1_000_000;
const maxStoredEntries = 100;
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
function validOperation(value: unknown): value is DiscussionOperation {
	if (
		!record(value) ||
		!text(value.id) ||
		!parseOperationId(value.id) ||
		!text(value.source) ||
		!text(value.authorKey) ||
		typeof value.account !== 'boolean' ||
		typeof value.uncertain !== 'boolean' ||
		(value.blocked !== undefined && typeof value.blocked !== 'boolean') ||
		!validate(discussionCommand, value.command) ||
		(value.threadId !== undefined && !text(value.threadId)) ||
		'submitted' in value
	)
		return false;
	return value.command.kind === 'delete'
		? value.source === `delete:${value.command.messageId}`
		: text(value.source) && value.source.length > 0;
}
function readStored(raw: string, authorKey: string, account: boolean): StoredOperations | null {
	if (raw.length > maxStoredLength) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (
		!record(value) ||
		value.version !== 2 ||
		!Array.isArray(value.operations) ||
		value.operations.length > maxStoredEntries ||
		!value.operations.every(validOperation) ||
		!Array.isArray(value.created) ||
		value.created.length > maxStoredEntries ||
		!value.created.every(
			(entry) => Array.isArray(entry) && entry.length === 2 && text(entry[0]) && text(entry[1])
		) ||
		value.operations.some(
			(operation) => operation.authorKey !== authorKey || operation.account !== account
		)
	)
		return null;
	return value as StoredOperations;
}

/** Persist only submitted writes and their result-tracking IDs for this buyer link. */
export class DiscussionRecovery {
	private cleanedLegacy = false;
	constructor(private token: string) {
		this.removeLegacyDrafts();
	}
	private key(authorKey: string, account: boolean) {
		return [
			'dinu:discussions:v2',
			encodeURIComponent(env.PUBLIC_CONVEX_URL ?? ''),
			encodeURIComponent(this.token),
			account ? 'account' : 'buyer',
			encodeURIComponent(authorKey)
		].join(':');
	}
	private removeLegacyDrafts() {
		if (this.cleanedLegacy || typeof sessionStorage === 'undefined') return;
		this.cleanedLegacy = true;
		try {
			for (let index = sessionStorage.length - 1; index >= 0; index--) {
				const key = sessionStorage.key(index);
				if (key?.startsWith('dinu:discussions:v1:')) sessionStorage.removeItem(key);
			}
		} catch {
			// Operation tracking still works for this shell lifetime.
		}
	}
	claim(authorKey: string, account: boolean, current: DiscussionWork) {
		this.removeLegacyDrafts();
		const key = this.key(authorKey, account);
		let raw = memory.get(key) ?? null;
		if (!raw) {
			try {
				raw = sessionStorage.getItem(key);
			} catch {
				// No browser storage is available.
			}
		}
		const stored = raw && readStored(raw, authorKey, account);
		if (raw && !stored) {
			memory.delete(key);
			try {
				sessionStorage.removeItem(key);
			} catch {
				// Invalid stored state is ignored.
			}
		}
		if (stored) {
			for (const item of stored.operations) {
				if (current.operations.has(item.source)) continue;
				const operation = $state<DiscussionOperation>({
					id: item.id,
					source: item.source,
					authorKey: item.authorKey,
					account: item.account,
					uncertain: true,
					blocked: item.blocked,
					threadId: item.threadId,
					command: item.command
				});
				current.operations.set(operation.source, operation);
			}
			for (const [operationId, threadId] of stored.created)
				if (!current.created.has(operationId)) current.created.set(operationId, threadId);
		}
		const claim = Symbol();
		latestClaim.set(key, claim);
		let claims = workClaims.get(current);
		if (!claims) {
			claims = new Map();
			workClaims.set(current, claims);
		}
		claims.set(key, claim);
		return current;
	}
	persist(authorKey: string, account: boolean, work: DiscussionWork) {
		this.removeLegacyDrafts();
		const key = this.key(authorKey, account);
		// A replaced session may finish a write later; only the latest claimant owns this record.
		const claim = workClaims.get(work)?.get(key);
		if (!claim || claim !== latestClaim.get(key)) return;
		const value: StoredOperations = {
			version: 2,
			operations: [...work.operations.values()].map((operation) => ({
				id: operation.id,
				source: operation.source,
				authorKey: operation.authorKey,
				account: operation.account,
				uncertain: true,
				blocked: operation.blocked,
				threadId: operation.threadId,
				command: $state.snapshot(operation.command)
			})),
			created: [...work.created]
		};
		if (!value.operations.length && !value.created.length) {
			memory.delete(key);
			try {
				sessionStorage.removeItem(key);
			} catch {
				// No browser storage is available.
			}
			return;
		}
		const raw = JSON.stringify(value);
		memory.set(key, raw);
		if (
			raw.length > maxStoredLength ||
			value.operations.length > maxStoredEntries ||
			value.created.length > maxStoredEntries
		) {
			try {
				sessionStorage.removeItem(key);
			} catch {
				// Tracking remains in memory for this shell lifetime.
			}
			return;
		}
		try {
			sessionStorage.setItem(key, raw);
		} catch {
			try {
				sessionStorage.removeItem(key);
			} catch {
				// Tracking remains in memory for this shell lifetime.
			}
		}
	}
}
export function setDiscussionRecovery(recovery: DiscussionRecovery) {
	return setContext(contextKey, recovery);
}
export function getDiscussionRecovery() {
	return getContext<DiscussionRecovery>(contextKey);
}
