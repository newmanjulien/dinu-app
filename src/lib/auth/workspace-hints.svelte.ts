import { getContext, setContext } from 'svelte';
import type { Role } from '../../convex/permissions';
import {
	readWorkspaceHints,
	rememberWorkspaceHints,
	cancelWorkspaceHintWrites,
	type WorkspaceMembership,
	type WorkspaceHintState,
	type WorkspacePresentation
} from './workspace-hints-storage';

import type { WorkspaceHintSeed } from './workspace-hint-cookie';
import type { MembershipRetirement } from './viewer-session.svelte';

type ConfirmedMembership = WorkspaceMembership & WorkspacePresentation & { templateReady: boolean };

/** Presentation hints only. Account admission and permissions use the live viewer. */
export class WorkspaceHints {
	private identity = $state.raw<{ userId: string; sessionId: string }>();
	private membership = $state.raw<WorkspaceHintState | null>();
	private confirmed = false;
	private storageRead = false;
	private membershipGeneration = 0;

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

	activate(userId: string, sessionId: string) {
		if (this.identity?.userId !== userId || this.identity.sessionId !== sessionId) {
			this.clear();
			this.identity = { userId, sessionId };
		}
		if (!this.storageRead) {
			this.storageRead = true;
			this.membership = readWorkspaceHints(userId, sessionId) ?? this.membership;
		}
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
		this.confirmed = true;
		if (
			this.membership?.membershipId !== membership?.membershipId ||
			this.membership?.companyId !== membership?.companyId
		)
			this.membershipGeneration++;
		this.membership = membership;
		rememberWorkspaceHints(userId, sessionId, this.membership);
	}

	cancelReads() {}

	captureMembershipRetirement({ userId, sessionId, membershipId }: MembershipRetirement) {
		const generation = this.membershipGeneration;
		const identity = this.identity;
		return () => {
			if (
				this.identity !== identity ||
				this.membershipGeneration !== generation ||
				this.membership?.membershipId !== membershipId
			)
				return;
			if (
				identity?.userId === userId &&
				(sessionId === undefined || identity.sessionId === sessionId)
			) {
				this.confirmed = true;
				this.membership = null;
				this.membershipGeneration++;
			}
		};
	}

	forgetAccount(userId: string) {
		if (this.identity?.userId === userId) this.confirm(userId, this.identity.sessionId, null);
	}

	clear() {
		this.membershipGeneration++;
		if (this.identity) cancelWorkspaceHintWrites(this.identity.userId, this.identity.sessionId);
		this.storageRead = false;
		this.identity = undefined;
		this.membership = undefined;
		this.confirmed = false;
	}
}

export interface WorkspaceHintContext {
	readonly role: Role | undefined;
	readonly presentation?: WorkspacePresentation;
	readonly templateReady: boolean | undefined;
}

const key = Symbol('workspace-hints');
export const setWorkspaceHints = (presentation: WorkspaceHintContext) =>
	setContext(key, presentation);
export const useWorkspaceHints = () =>
	getContext<WorkspaceHintContext | undefined>(key) ?? {
		role: undefined,
		presentation: undefined,
		templateReady: undefined
	};
