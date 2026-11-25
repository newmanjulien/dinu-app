import { getContext, setContext } from 'svelte';
import type { ConvexClient } from 'convex/browser';
import type { AccountViewer } from './viewer-session.svelte';

/** Application state survives the lazy authenticated driver's startup and transport retries. */
export class AccountContext {
	account = $state.raw<AccountViewer | null>();
	client = $state.raw<ConvexClient>();
	authenticated = $state(false);
	loading = $state(true);
	rejected = $state(false);
	identity = $state<string>();

	clear() {
		this.account = undefined;
		this.client = undefined;
		this.authenticated = false;
		this.loading = true;
		this.rejected = false;
		this.identity = undefined;
	}
}
const key = Symbol('account-context');
export const setAccountContext = () => setContext(key, new AccountContext());
export const useAccountContext = () => getContext<AccountContext | undefined>(key);
