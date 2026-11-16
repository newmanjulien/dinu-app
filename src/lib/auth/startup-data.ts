import type { FunctionReturnType } from 'convex/server';
import { getContext, setContext } from 'svelte';
import type { api } from '../../convex/_generated/api';

export type StartupData = { viewer: FunctionReturnType<typeof api.accounts.viewer> } & {
	sessionId: string;
	userId: string;
};
const key = Symbol('startup-data');
export const setStartupData = (read: () => StartupData | null) => setContext(key, read);
export const useStartupData = () => getContext<() => StartupData | null>(key) ?? (() => null);

export type StartupHome = FunctionReturnType<typeof api.accounts.startupHome> & {
	sessionId: string;
	userId: string;
};
const homeKey = Symbol('startup-home');
export const setStartupHome = (read: () => StartupHome | null) => setContext(homeKey, read);
export const useStartupHome = () => getContext<() => StartupHome | null>(homeKey) ?? (() => null);

export type StartupSetup = FunctionReturnType<typeof api.accounts.setupStartup> & {
	sessionId: string;
	userId: string;
};
const setupKey = Symbol('startup-setup');
export const setStartupSetup = (read: () => StartupSetup | null) => setContext(setupKey, read);
export const useStartupSetup = () =>
	getContext<() => StartupSetup | null>(setupKey) ?? (() => null);
