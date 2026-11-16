import { getContext, setContext } from 'svelte';

const key = Symbol('workspace-runtime');
export interface WorkspaceRuntime {
	readonly hostReady: boolean;
	readonly paused: boolean;
	readonly error: string;
	readonly navigationIntent: number;
	retry: () => void;
}
export function setWorkspaceRuntime(runtime: WorkspaceRuntime) {
	return setContext(key, runtime);
}
export function getWorkspaceRuntime(): WorkspaceRuntime {
	return getContext(key);
}

const destinationsKey = Symbol('workspace-destinations');
const ownershipTimeout = 5_000;
/** One optional intent and one incoming navigation, using the destination's real read owners. */
export class WorkspaceDestinations {
	private intent?: { path: string; release: () => void };
	private navigation?: { path: string; release: () => void };
	private cooldownUntil = 0;
	private ready = false;
	constructor(
		private readonly options: {
			available: () => boolean;
			acquire: (path: string) => (() => void) | undefined;
		}
	) {}
	configure(ready: boolean) {
		this.ready = ready;
		if (!this.options.available()) this.clear();
	}
	mount() {
		const input = () => {
			this.cooldownUntil = Date.now() + 250;
		};
		const visibility = () => {
			if (document.hidden) this.clear();
		};
		for (const type of ['scroll', 'keydown', 'pointerdown'])
			window.addEventListener(type, input, { passive: true, capture: true });
		document.addEventListener('visibilitychange', visibility);
		return () => {
			for (const type of ['scroll', 'keydown', 'pointerdown'])
				window.removeEventListener(type, input, true);
			document.removeEventListener('visibilitychange', visibility);
			this.clear();
		};
	}
	prepare(path: string) {
		const device = navigator as Navigator & {
			deviceMemory?: number;
			connection?: { saveData?: boolean };
		};
		if (
			!this.ready ||
			!this.options.available() ||
			document.hidden ||
			Date.now() < this.cooldownUntil ||
			device.connection?.saveData ||
			(device.deviceMemory && device.deviceMemory <= 4) ||
			(device.hardwareConcurrency && device.hardwareConcurrency <= 4)
		)
			return;
		this.reserve('intent', path);
	}
	navigate(path: string) {
		return this.reserve('navigation', path);
	}
	/** Incoming foreground demand is acquired before optional ownership can be released. */
	retain(path: string) {
		const release = this.options.available() ? this.options.acquire(path) : undefined;
		if (this.intent?.path === path) this.intent.release();
		if (this.navigation?.path === path) this.navigation.release();
		return release;
	}
	private reserve(kind: 'intent' | 'navigation', path: string) {
		const previous = this[kind];
		const releaseRead = this.options.available() ? this.options.acquire(path) : undefined;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			clearTimeout(timer);
			releaseRead?.();
			if (this[kind]?.release === release) this[kind] = undefined;
		};
		const timer = setTimeout(release, ownershipTimeout);
		this[kind] = { path, release };
		previous?.release();
		if (kind === 'navigation') this.intent?.release();
		return release;
	}
	clear() {
		this.intent?.release();
		this.navigation?.release();
	}
}
export const setWorkspaceDestinations = (destinations: WorkspaceDestinations) =>
	setContext(destinationsKey, destinations);
export const getWorkspaceDestinations = () =>
	getContext<WorkspaceDestinations | undefined>(destinationsKey);
