import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import { afterStartupPaint } from './startup-perf';
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
const MAX_BYTES = 16 * 1024;
let pending:
	{ userId: string; sessionId: string; comparison: string; cancel: () => void } | undefined;
let remembered: string | undefined;

function key(userId: string) {
	return `dinu:v3:${env.PUBLIC_CONVEX_URL ?? ''}:workspace-presentation:${userId}`;
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

/** Nonessential persistence follows useful rendering; absence cancels queued writes. */
export function rememberWorkspaceHints(
	userId: string,
	sessionId: string,
	membership: WorkspaceHintState | null
) {
	if (!browser) return;
	const storageKey = key(userId);
	if (!membership) {
		cancelWorkspaceHintWrites(userId, sessionId);
		remembered = undefined;
		try {
			if (readWorkspaceHintCookie(browserCookie(), userId, sessionId))
				document.cookie = `${WORKSPACE_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
		} catch {
			/* Optional storage. */
		}
		try {
			localStorage.removeItem(storageKey);
		} catch {
			/* Optional storage. */
		}
		return;
	}
	const hints = workspaceLayoutHints(membership);
	if (!hints) return;
	const display = presentation(membership);
	const comparison = JSON.stringify({ userId, sessionId, hints, display });
	if (pending?.comparison === comparison) return;
	pending?.cancel();
	pending = undefined;
	if (remembered === comparison) return;
	const cancel = afterStartupPaint(() => {
		pending = undefined;
		const raw = encodeWorkspaceHintCookie({ userId, sessionId, hints });
		if (!raw) return;
		try {
			const secure = location.protocol === 'https:' ? '; Secure' : '';
			document.cookie = `${WORKSPACE_HINT_COOKIE}=${encodeURIComponent(raw)}; Path=/; Max-Age=${WORKSPACE_HINT_MAX_AGE}; SameSite=Lax${secure}`;
			remembered = comparison;
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
	pending = { userId, sessionId, comparison, cancel };
}
