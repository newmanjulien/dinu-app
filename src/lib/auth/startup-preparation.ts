import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import type { ConvexClient } from 'convex/browser';
import { getContext, setContext } from 'svelte';

const key = Symbol('startupPreparation');

/** Open a connection during sign-in restoration or verification, then hand it to the session. */
class StartupPreparation {
	private client: ConvexClient | undefined;
	private pending: Promise<void> | undefined;
	private generation = 0;

	warm() {
		if (!browser || !env.PUBLIC_CONVEX_URL || this.client || this.pending) return;
		const generation = this.generation;
		this.pending = import('convex/browser')
			.then(({ ConvexClient }) => {
				if (generation === this.generation)
					this.client = new ConvexClient(env.PUBLIC_CONVEX_URL!, { initialAuthTokenReuse: true });
			})
			.catch(() => {})
			.finally(() => {
				if (generation === this.generation) this.pending = undefined;
			});
	}

	take() {
		const client = this.client;
		this.client = undefined;
		this.pending = undefined;
		this.generation++;
		return client;
	}

	cancel() {
		const client = this.take();
		void client?.close().catch(() => {});
	}
}

export const setStartupPreparation = () => setContext(key, new StartupPreparation());
export const useStartupPreparation = () => getContext<StartupPreparation>(key);
