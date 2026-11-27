import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import { afterStartupPaint } from './startup-perf';
import type { MembershipRetirement } from './viewer-session.svelte';
import {
	WORKSPACE_HINT_COOKIE,
	WORKSPACE_HINT_MAX_AGE,
	encodeWorkspaceHintCookie,
	readWorkspaceHintCookie,
	workspaceLayoutHints,
	hintText,
	type WorkspaceLayoutHints,
	type WorkspaceScope
} from './workspace-hint-cookie';

export type { WorkspaceMembership, WorkspaceScope } from './workspace-hint-cookie';
export type WorkspacePresentation = {
	name?: string;
	avatarUrl?: string | null;
	companyName?: string;
	companyAvatarUrl?: string | null;
	instructionsReady?: boolean;
};
export type WorkspaceHintState = WorkspaceLayoutHints & WorkspacePresentation;

type StoredPresentation = WorkspaceScope & Omit<WorkspacePresentation, 'instructionsReady'>;
export type WorkspaceHintIdentity = { userId: string; sessionId: string };
type RememberedHints = WorkspaceHintIdentity & { membershipId: string; comparison: string };
const MAX_BYTES = 16 * 1024;
let pending: (RememberedHints & { cancel: () => void }) | undefined;
let remembered: RememberedHints | undefined;

function presentationPrefix() {
	return `dinu:v3:${env.PUBLIC_CONVEX_URL ?? ''}:workspace-presentation:`;
}

function key(userId: string) {
	return `${presentationPrefix()}${userId}`;
}

const avatar = (value: unknown) => (value === null ? null : hintText(value, 4096));
function presentation(value: WorkspaceHintState): StoredPresentation {
	return {
		membershipId: value.membershipId,
		companyId: value.companyId,
		name: hintText(value.name, 512),
		avatarUrl: avatar(value.avatarUrl),
		companyName: hintText(value.companyName, 512),
		companyAvatarUrl: avatar(value.companyAvatarUrl)
	};
}

function browserCookie() {
	const value = document.cookie
		.split('; ')
		.find((entry) => entry.startsWith(`${WORKSPACE_HINT_COOKIE}=`));
	return value ? decodeURIComponent(value.slice(WORKSPACE_HINT_COOKIE.length + 1)) : undefined;
}

/** Layout facts have one cookie source; larger display fields stay off request headers. */
export function readWorkspaceHints(
	userId: string,
	sessionId: string
): WorkspaceHintState | undefined {
	if (!browser) return;
	let hints: WorkspaceHintState | undefined;
	try {
		hints = readWorkspaceHintCookie(browserCookie(), userId, sessionId)?.hints;
		if (!hints) return;
		const raw = localStorage.getItem(key(userId));
		if (!raw || raw.length > MAX_BYTES || new TextEncoder().encode(raw).byteLength > MAX_BYTES)
			return hints;
		const record = JSON.parse(raw);
		if (
			!record ||
			record.version !== 3 ||
			record.sessionId !== sessionId ||
			typeof record.savedAt !== 'number' ||
			!Number.isFinite(record.savedAt) ||
			record.savedAt > Date.now() ||
			Date.now() - record.savedAt >= WORKSPACE_HINT_MAX_AGE * 1000 ||
			record.presentation?.membershipId !== hints.membershipId ||
			record.presentation?.companyId !== hints.companyId
		)
			return hints;
		return { ...hints, ...presentation(record.presentation) };
	} catch {
		/* Cookie hints remain useful when local display storage is unavailable. */
		return hints;
	}
}

export function cancelWorkspaceHintWrites(userId: string, sessionId: string) {
	if (pending?.userId !== userId || pending.sessionId !== sessionId) return;
	pending.cancel();
	pending = undefined;
}

function storedRecord(raw: string | null | undefined): Record<string, unknown> | undefined {
	if (!raw || raw.length > MAX_BYTES || new TextEncoder().encode(raw).byteLength > MAX_BYTES)
		return;
	try {
		const record: unknown = JSON.parse(raw);
		return record && typeof record === 'object' ? (record as Record<string, unknown>) : undefined;
	} catch {
		/* Unusable display records still have a deployment/user-scoped key. */
	}
}

/** Ownership, not freshness or presentation validity, determines physical removal. */
function removeWorkspaceHints(
	matches: (userId: string, sessionId: string | undefined, membershipId?: string) => boolean,
	removeLegacy = false
) {
	if (!browser) return;
	if (pending && matches(pending.userId, pending.sessionId, pending.membershipId)) {
		pending.cancel();
		pending = undefined;
	}
	if (remembered && matches(remembered.userId, remembered.sessionId, remembered.membershipId))
		remembered = undefined;
	try {
		const raw = browserCookie();
		const record = storedRecord(raw);
		const userId = hintText(record?.userId, 256);
		if (
			(raw && !record && removeLegacy) ||
			(record?.deployment === env.PUBLIC_CONVEX_URL &&
				userId &&
				matches(
					userId,
					hintText(record.sessionId, 256),
					hintText((record.hints as Record<string, unknown> | undefined)?.membershipId, 256)
				))
		)
			document.cookie = `${WORKSPACE_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
	} catch {
		/* Cookie failure must not prevent localStorage cleanup. */
	}
	try {
		const prefix = presentationPrefix();
		const legacyPrefix = `dinu:v9:${env.PUBLIC_CONVEX_URL ?? ''}:`;
		const obsoleteKey = (storageKey: string) =>
			removeLegacy &&
			storageKey.startsWith(legacyPrefix) &&
			(storageKey.endsWith(':cards') || storageKey.endsWith(':openings'));
		const keys: string[] = [];
		for (let index = 0; index < localStorage.length; index++) {
			const storageKey = localStorage.key(index);
			if (storageKey && (storageKey.startsWith(prefix) || obsoleteKey(storageKey)))
				keys.push(storageKey);
		}
		for (const storageKey of keys) {
			try {
				if (obsoleteKey(storageKey)) {
					// Inspect names only; no historical card/opening payload reader.
					localStorage.removeItem(storageKey);
					continue;
				}
				const record = storedRecord(localStorage.getItem(storageKey));
				if (
					matches(
						storageKey.slice(prefix.length),
						hintText(record?.sessionId, 256),
						hintText(
							(record?.presentation as Record<string, unknown> | undefined)?.membershipId,
							256
						)
					)
				)
					localStorage.removeItem(storageKey);
			} catch {
				/* Continue removing other records when one operation fails. */
			}
		}
	} catch {
		/* Optional display storage. */
	}
}

export function clearWorkspaceHints(userId: string, sessionId?: string) {
	removeWorkspaceHints(
		(storedUserId, storedSessionId) =>
			storedUserId === userId &&
			(sessionId === undefined || storedSessionId === undefined || storedSessionId === sessionId)
	);
}

/** A departure cannot remove another membership's pending or persisted presentation. */
export function clearWorkspaceMembershipHints(owner: MembershipRetirement) {
	removeWorkspaceHints(
		(userId, sessionId, membershipId) =>
			userId === owner.userId &&
			membershipId === owner.membershipId &&
			(owner.sessionId === undefined || sessionId === owner.sessionId)
	);
}

/** Keep only the identified session, independently of mounted presentation owners. */
export function retireWorkspaceHints(current?: WorkspaceHintIdentity) {
	removeWorkspaceHints(
		(userId, sessionId) => userId !== current?.userId || sessionId !== current?.sessionId,
		true
	);
}

/** Nonessential persistence follows useful rendering; absence cancels queued writes. */
export function rememberWorkspaceHints(
	userId: string,
	sessionId: string,
	membership: WorkspaceHintState | null
) {
	if (!browser) return;
	const storageKey = key(userId);
	if (!membership) {
		clearWorkspaceHints(userId, sessionId);
		return;
	}
	const hints = workspaceLayoutHints(membership);
	if (!hints) return;
	const display = presentation(membership);
	const comparison = JSON.stringify({ userId, sessionId, hints, display });
	if (pending?.comparison === comparison) return;
	pending?.cancel();
	pending = undefined;
	if (remembered?.comparison === comparison) return;
	const write = {
		userId,
		sessionId,
		membershipId: hints.membershipId,
		comparison,
		cancel: () => {}
	};
	pending = write;
	write.cancel = afterStartupPaint(() => {
		if (pending !== write) return;
		pending = undefined;
		const raw = encodeWorkspaceHintCookie({ userId, sessionId, hints });
		if (!raw) return;
		try {
			const secure = location.protocol === 'https:' ? '; Secure' : '';
			document.cookie = `${WORKSPACE_HINT_COOKIE}=${encodeURIComponent(raw)}; Path=/; Max-Age=${WORKSPACE_HINT_MAX_AGE}; SameSite=Lax${secure}`;
			remembered = { userId, sessionId, membershipId: hints.membershipId, comparison };
		} catch {
			/* Keep in-memory layout hints. */
		}
		const encode = () =>
			JSON.stringify({ version: 3, sessionId, savedAt: Date.now(), presentation: display });
		let encoded = encode();
		if (new TextEncoder().encode(encoded).byteLength > MAX_BYTES) {
			display.avatarUrl = undefined;
			display.companyAvatarUrl = undefined;
			encoded = encode();
		}
		if (new TextEncoder().encode(encoded).byteLength > MAX_BYTES) return;
		try {
			localStorage.setItem(storageKey, encoded);
		} catch {
			/* Keep in-memory display fields. */
		}
	});
}
