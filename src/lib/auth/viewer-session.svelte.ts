import type { FunctionReturnType } from 'convex/server';
import { getContext, setContext } from 'svelte';
import type { api } from '../../convex/_generated/api';
export type AccountViewer = NonNullable<FunctionReturnType<typeof api.accounts.viewer>>;
export type Viewer = AccountViewer & {
	company: NonNullable<AccountViewer['company']>;
	membership: NonNullable<AccountViewer['membership']>;
};
const sessionKey = Symbol('viewerSession');
const viewerKey = Symbol('viewer');
const accountKey = Symbol('account');
export type SessionPhase =
	| 'loading'
	| 'authenticating'
	| 'preparing'
	| 'ready'
	| 'saving-before-logout'
	| 'saving-before-company-exit'
	| 'signing-out'
	| 'authentication-error'
	| 'signed-out';
export type SessionEditor = {
	readonly pending: boolean;
	prepareToLeave: () => Promise<boolean>;
	retry: () => void;
	suspend: () => void;
	resume: () => void;
	freeze: (frozen: boolean) => void;
	discard: () => void;
	restartTransport: () => void;
};
export type SessionResources = { cancelReads: () => void; clear: () => void };
type Session = {
	readonly closing: boolean;
	readonly preparedSessionId: string | null | undefined;
	readonly userId: string | null;
	readonly phase: SessionPhase;
	readonly error: string;
	readonly authenticationError: string;
	readonly delayed: boolean;
	readonly blocked: boolean;
	readonly workspaceAdmitted: boolean;
	readonly transportGeneration: number;
	registerEditor: (editor: SessionEditor) => () => void;
	registerResources: (resources: SessionResources) => void;
	reportAuth: (loading: boolean, authenticated: boolean) => void;
	reportAccount: (ready: boolean, error?: string) => void;
	retryAuth: () => void;
	cancelSignOut: () => void;
	discardAndSignOut: () => void;
	dismissError: () => void;
	returnToLogin: () => void;
	reset: () => void;
	completeAccountDeletion: (context: { sessionId: string; userId: string }) => void;
	signOut: () => Promise<void>;
	exitCompany: (action: () => Promise<unknown>, discard?: boolean) => Promise<void>;
};
export const setViewerSession = (session: Session) => setContext(sessionKey, session);
export const useViewerSession = () => getContext<Session>(sessionKey);
export const setViewer = (viewer: () => Viewer) => setContext(viewerKey, viewer);
export const useViewer = () => getContext<() => Viewer>(viewerKey);

export const setAccount = (account: () => AccountViewer | undefined) =>
	setContext(accountKey, account);
export const useAccount = () => getContext<() => AccountViewer | undefined>(accountKey);
