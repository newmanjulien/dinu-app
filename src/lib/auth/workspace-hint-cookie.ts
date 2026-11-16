import { env } from '$env/dynamic/public';
import type { Id } from '../../convex/_generated/dataModel';
import type { Role } from '../../convex/permissions';

export type WorkspaceMembership = {
	membershipId: Id<'memberships'>;
	companyId: Id<'company'>;
	role: Role;
};
export type WorkspaceScope = Pick<WorkspaceMembership, 'membershipId' | 'companyId'>;
export type WorkspaceLayoutHints = WorkspaceMembership & {
	templateReady?: boolean;
	hasBuyerLinks?: boolean;
	instructionsReady?: boolean;
};
export type WorkspaceHintSeed = {
	userId: string;
	sessionId: string;
	hints: WorkspaceLayoutHints;
};

export const WORKSPACE_HINT_COOKIE = 'dinu_workspace_hints';
export const WORKSPACE_HINT_MAX_AGE = 24 * 60 * 60;
const MAX_COOKIE_LENGTH = 3000;
// The browser writes the timestamp; allow modest drift from the server clock.
const MAX_CLOCK_SKEW = 5 * 60 * 1000;
export const hintText = (value: unknown, max: number) =>
	typeof value === 'string' && value.length <= max ? value : undefined;

export function workspaceLayoutHints(value: unknown): WorkspaceLayoutHints | undefined {
	if (!value || typeof value !== 'object') return;
	const fields = value as Record<string, unknown>;
	if (
		!hintText(fields.membershipId, 256) ||
		!hintText(fields.companyId, 256) ||
		(fields.role !== 'admin' && fields.role !== 'rep') ||
		['templateReady', 'hasBuyerLinks', 'instructionsReady'].some(
			(key) => fields[key] !== undefined && typeof fields[key] !== 'boolean'
		)
	)
		return;
	return {
		membershipId: fields.membershipId as Id<'memberships'>,
		companyId: fields.companyId as Id<'company'>,
		role: fields.role,
		templateReady: fields.templateReady as boolean | undefined,
		hasBuyerLinks: fields.hasBuyerLinks as boolean | undefined,
		instructionsReady: fields.instructionsReady as boolean | undefined
	};
}

/** The cookie selects placeholders only; it is never evidence of access or permissions. */
export function encodeWorkspaceHintCookie(seed: WorkspaceHintSeed): string | undefined {
	const hints = workspaceLayoutHints(seed.hints);
	if (!hints || !hintText(seed.userId, 256) || !hintText(seed.sessionId, 256)) return;
	const raw = JSON.stringify({
		version: 1,
		deployment: env.PUBLIC_CONVEX_URL,
		userId: seed.userId,
		sessionId: seed.sessionId,
		savedAt: Date.now(),
		hints
	});
	return encodeURIComponent(raw).length <= MAX_COOKIE_LENGTH ? raw : undefined;
}

/** Receives the decoded value from SvelteKit cookies or the browser cookie reader. */
export function readWorkspaceHintCookie(
	raw: string | undefined,
	userId: string,
	sessionId: string
): WorkspaceHintSeed | undefined {
	if (!raw || raw.length > MAX_COOKIE_LENGTH) return;
	try {
		if (encodeURIComponent(raw).length > MAX_COOKIE_LENGTH) return;
		const record: unknown = JSON.parse(raw);
		if (!record || typeof record !== 'object') return;
		const fields = record as Record<string, unknown>;
		const now = Date.now();
		if (
			fields.version !== 1 ||
			fields.deployment !== env.PUBLIC_CONVEX_URL ||
			fields.userId !== userId ||
			fields.sessionId !== sessionId ||
			typeof fields.savedAt !== 'number' ||
			!Number.isFinite(fields.savedAt) ||
			fields.savedAt > now + MAX_CLOCK_SKEW ||
			now - fields.savedAt >= WORKSPACE_HINT_MAX_AGE * 1000
		)
			return;
		const hints = workspaceLayoutHints(fields.hints);
		return hints ? { userId, sessionId, hints } : undefined;
	} catch {
		/* Malformed or unavailable hints leave the neutral skeleton in place. */
	}
}
