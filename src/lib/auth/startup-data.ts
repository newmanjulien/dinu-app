import type { FunctionReturnType } from 'convex/server';
import { getContext, setContext } from 'svelte';
import type { api } from '../../convex/_generated/api';

export type StartupData = FunctionReturnType<typeof api.accounts.startup> & {
	sessionId: string;
	userId: string;
};
const key = Symbol('startup-data');
export const setStartupData = (read: () => StartupData | null) => setContext(key, read);
export const useStartupData = () => getContext<() => StartupData | null>(key) ?? (() => null);
