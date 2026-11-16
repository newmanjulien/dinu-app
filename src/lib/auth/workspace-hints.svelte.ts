import { getContext, setContext } from 'svelte';
import type { Role } from '../../convex/permissions';
import { ReadAttempt, waitForRead } from './attempt';
import {
	readWorkspaceHints,
	rememberWorkspaceHints,
	cancelWorkspaceHintWrites,
	type WorkspaceMembership,
	type WorkspaceHintState,
	type WorkspaceScope,
	type WorkspacePresentation
} from './workspace-hints-storage';

import type { WorkspaceHintSeed } from './workspace-hint-cookie';

type ConfirmedMembership = WorkspaceMembership & WorkspacePresentation & { templateReady: boolean };

/** Presentation hints only. Account admission and permissions use the live viewer. */
export class WorkspaceHints {
	private identity = $state.raw<{ userId: string; sessionId: string }>();
	private membership = $state.raw<WorkspaceHintState | null>();
	private confirmed = false;
	private attemptedGeneration: number | undefined;
	private request: ReadAttempt | undefined;
	private storageRead = false;

	constructor(seed?: WorkspaceHintSeed) {
		if (seed) {
			this.identity = { userId: seed.userId, sessionId: seed.sessionId };
			this.membership = seed.hints;
		}
	}

	roleFor(userId: string | undefined, sessionId: string | undefined): Role | undefined {
		return this.identity?.userId === userId && this.identity?.sessionId === sessionId
			? this.membership?.role
			: undefined;
	}

	templateReadyFor(userId: string | undefined, sessionId: string | undefined): boolean | undefined {
		return this.identity?.userId === userId && this.identity?.sessionId === sessionId
			? this.membership?.templateReady
			: undefined;
	}

	presentationFor(
		userId: string | undefined,
		sessionId: string | undefined
	): WorkspacePresentation | undefined {
		return this.identity?.userId === userId && this.identity?.sessionId === sessionId
			? (this.membership ?? undefined)
			: undefined;
	}

	buyerLinksFor(
		userId: string | undefined,
		sessionId: string | undefined,
		scope?: WorkspaceScope
	): boolean | undefined {
		if (
			this.identity?.userId !== userId ||
			this.identity?.sessionId !== sessionId ||
			(scope && !this.matchesScope(scope))
		)
			return undefined;
		return this.membership?.hasBuyerLinks;
	}

	private matchesScope(scope: WorkspaceScope) {
		return (
			this.membership?.membershipId === scope.membershipId &&
			this.membership?.companyId === scope.companyId
		);
	}

	private activate(userId: string, sessionId: string) {
		if (this.identity?.userId !== userId || this.identity.sessionId !== sessionId) {
			this.clear();
			this.identity = { userId, sessionId };
		}
		if (!this.storageRead) {
			this.storageRead = true;
			this.membership = readWorkspaceHints(userId, sessionId) ?? this.membership;
		}
	}

	prepare(
		userId: string,
		sessionId: string,
		generation: number,
		getToken: () => Promise<string | null>
	) {
		this.activate(userId, sessionId);
		if (this.membership !== undefined || this.attemptedGeneration === generation) return;
		this.cancelReads();
		this.attemptedGeneration = generation;
		const request = new ReadAttempt(5_000);
		this.request = request;
		void (async () => {
			const [{ fetchWorkspaceRole }, token] = await waitForRead(
				Promise.all([import('./workspace-role-query'), getToken()]),
				request.signal
			);
			if (!token) return;
			const value = await waitForRead(fetchWorkspaceRole(token, request.signal), request.signal);
			if (this.request !== request || request.signal.aborted || this.confirmed) return;
			this.membership = value;
			rememberWorkspaceHints(userId, sessionId, value);
		})()
			.catch(() => {
				/* Full account startup and its recovery controls remain active. */
			})
			.finally(() => {
				request.complete();
				if (this.request === request) this.request = undefined;
			});
	}

	confirm(userId: string, sessionId: string, membership: ConfirmedMembership | null) {
		this.activate(userId, sessionId);
		if (
			this.confirmed &&
			this.membership?.membershipId === membership?.membershipId &&
			this.membership?.companyId === membership?.companyId &&
			this.membership?.role === membership?.role &&
			this.membership?.templateReady === membership?.templateReady &&
			this.membership?.name === membership?.name &&
			this.membership?.avatarUrl === membership?.avatarUrl &&
			this.membership?.companyName === membership?.companyName &&
			this.membership?.companyAvatarUrl === membership?.companyAvatarUrl &&
			this.membership?.instructionsReady === membership?.instructionsReady
		)
			return;
		this.cancelReads();
		this.confirmed = true;
		const hasBuyerLinks =
			membership && this.matchesScope(membership) ? this.membership?.hasBuyerLinks : undefined;
		this.membership = membership ? { ...membership, hasBuyerLinks } : null;
		rememberWorkspaceHints(userId, sessionId, this.membership);
	}

	rememberBuyerLinks(
		userId: string,
		sessionId: string,
		membership: ConfirmedMembership,
		present: boolean
	) {
		this.confirm(userId, sessionId, {
			...(this.matchesScope(membership) ? this.membership : undefined),
			...membership
		});
		if (!this.membership || this.membership.hasBuyerLinks === present) return;
		this.membership = { ...this.membership, hasBuyerLinks: present };
		rememberWorkspaceHints(userId, sessionId, this.membership);
	}

	cancelReads() {
		const request = this.request;
		this.request = undefined;
		request?.abort();
	}

	forgetMembership(userId: string) {
		if (this.identity?.userId === userId) this.confirm(userId, this.identity.sessionId, null);
	}

	clear() {
		this.cancelReads();
		if (this.identity) cancelWorkspaceHintWrites(this.identity.userId, this.identity.sessionId);
		this.storageRead = false;
		this.identity = undefined;
		this.membership = undefined;
		this.confirmed = false;
		this.attemptedGeneration = undefined;
	}
}

export interface WorkspaceHintContext {
	readonly role: Role | undefined;
	readonly presentation?: WorkspacePresentation;
	readonly templateReady: boolean | undefined;
	readonly hasBuyerLinks: boolean | undefined;
	rememberBuyerLinks: (scope: WorkspaceScope, present: boolean) => void;
}

const key = Symbol('workspace-hints');
export const setWorkspaceHints = (presentation: WorkspaceHintContext) =>
	setContext(key, presentation);
export const useWorkspaceHints = () =>
	getContext<WorkspaceHintContext | undefined>(key) ?? {
		role: undefined,
		presentation: undefined,
		templateReady: undefined,
		hasBuyerLinks: undefined,
		rememberBuyerLinks: () => {}
	};
