import { getContext, setContext } from 'svelte';
import type { Role } from '../../convex/permissions';
import { ReadAttempt, waitForRead } from './attempt';
import {
	readWorkspaceRole,
	rememberWorkspaceRole,
	type WorkspaceMembership
} from './workspace-role-storage';

/** A presentation hint only. Account admission and permissions use the live viewer. */
export class WorkspaceRole {
	private identity = $state.raw<{ userId: string; sessionId: string }>();
	private membership = $state.raw<WorkspaceMembership | null>();
	private confirmed = false;
	private attemptedGeneration: number | undefined;
	private request: ReadAttempt | undefined;

	roleFor(userId: string | undefined, sessionId: string | undefined): Role | undefined {
		return this.identity?.userId === userId && this.identity?.sessionId === sessionId
			? this.membership?.role
			: undefined;
	}

	private activate(userId: string, sessionId: string) {
		if (this.identity?.userId === userId && this.identity.sessionId === sessionId) return;
		this.clear();
		this.identity = { userId, sessionId };
		this.membership = readWorkspaceRole(userId);
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
			rememberWorkspaceRole(userId, value);
		})()
			.catch(() => {
				/* Full account startup and its recovery controls remain active. */
			})
			.finally(() => {
				request.complete();
				if (this.request === request) this.request = undefined;
			});
	}

	confirm(userId: string, sessionId: string, membership: WorkspaceMembership | null) {
		this.activate(userId, sessionId);
		if (
			this.confirmed &&
			this.membership?.membershipId === membership?.membershipId &&
			this.membership?.companyId === membership?.companyId &&
			this.membership?.role === membership?.role
		)
			return;
		this.cancelReads();
		this.confirmed = true;
		this.membership = membership;
		rememberWorkspaceRole(userId, membership);
	}

	cancelReads() {
		const request = this.request;
		this.request = undefined;
		request?.abort();
	}

	forgetMembership(userId: string) {
		if (this.identity?.userId === userId) this.confirm(userId, this.identity.sessionId, null);
		else rememberWorkspaceRole(userId, null);
	}

	clear() {
		this.cancelReads();
		this.identity = undefined;
		this.membership = undefined;
		this.confirmed = false;
		this.attemptedGeneration = undefined;
	}
}

const key = Symbol('workspace-role');
export const setWorkspaceRole = (role: () => Role | undefined) => setContext(key, role);
export const useWorkspaceRole = () =>
	getContext<(() => Role | undefined) | undefined>(key) ?? (() => undefined);
