import type { FunctionReturnType } from 'convex/server';
import { getContext, setContext } from 'svelte';
import type { api } from '../../convex/_generated/api';

export type StartupData = FunctionReturnType<typeof api.accounts.homeBootstrap> & {
	sessionId: string;
	userId: string;
};
const key = Symbol('startup-data');
export const setStartupData = (read: () => StartupData | null) => setContext(key, read);
export const useStartupData = () => getContext<() => StartupData | null>(key) ?? (() => null);

export type StartupHome = NonNullable<
	FunctionReturnType<typeof api.accounts.homeBootstrap>['home']
> & {
	sessionId: string;
	userId: string;
};
const homeKey = Symbol('startup-home');
export const setStartupHome = (read: () => StartupHome | null) => setContext(homeKey, read);
export const useStartupHome = () => getContext<() => StartupHome | null>(homeKey) ?? (() => null);

export type StartupSetup = NonNullable<
	FunctionReturnType<typeof api.accounts.homeBootstrap>['setup']
> & {
	sessionId: string;
	userId: string;
};
const setupKey = Symbol('startup-setup');
export const setStartupSetup = (read: () => StartupSetup | null) => setContext(setupKey, read);
export const useStartupSetup = () =>
	getContext<() => StartupSetup | null>(setupKey) ?? (() => null);
