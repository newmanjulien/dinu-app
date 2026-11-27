import { expect, it, vi, afterEach } from 'vitest';
import { getFunctionName } from 'convex/server';
import { load as home } from '../../src/routes/(workspace)/contracts/+page.server';
import { load as invitation } from '../../src/routes/(entry)/invitation/+page.server';
const requests = vi.hoisted(() => ({
	pending: new Map<string, { resolve: (value: unknown) => void; signal: AbortSignal }>()
}));
vi.mock('convex/browser', () => ({
	ConvexHttpClient: class {
		signal!: AbortSignal;
		constructor(_url: string, options: any) {
			const fetch = vi.fn((_input, init) => {
				this.signal = init.signal;
				return Promise.resolve({});
			});
			const original = globalThis.fetch;
			globalThis.fetch = fetch as any;
			options.fetch('https://test.local', {});
			globalThis.fetch = original;
		}
		setAuth() {}
		query(ref: any) {
			return new Promise((resolve) =>
				requests.pending.set(getFunctionName(ref), { resolve, signal: this.signal })
			);
		}
		action(ref: any) {
			return this.query(ref);
		}
	}
}));
afterEach(() => {
	requests.pending.clear();
	vi.useRealTimers();
});
it('returns Contracts HTML immediately with one bounded, scoped bootstrap stream', async () => {
	vi.useFakeTimers();
	const event = {
		locals: { auth: () => ({ sessionId: 's', userId: 'u', getToken: async () => 't' }) },
		isDataRequest: false
	} as any;
	const result = home(event) as any;
	expect(result).not.toBeInstanceOf(Promise);
	await Promise.resolve();
	await Promise.resolve();
	expect([...requests.pending.keys()]).toEqual(['accounts:homeBootstrap']);
	requests.pending
		.get('accounts:homeBootstrap')!
		.resolve({ viewer: null, home: null, setup: null });
	expect(await result.startup).toEqual({
		viewer: null,
		home: null,
		setup: null,
		userId: 'u',
		sessionId: 's'
	});
	requests.pending.clear();
	const stalled = home(event) as any;
	await Promise.resolve();
	await Promise.resolve();
	expect(requests.pending.get('accounts:homeBootstrap')!.signal.aborted).toBe(false);
	await vi.advanceTimersByTimeAsync(5_001);
	expect(await stalled.startup).toBeNull();
	expect(requests.pending.get('accounts:homeBootstrap')!.signal.aborted).toBe(true);
});
it('streams an anonymous invitation and bounds a service that ignores cancellation', async () => {
	vi.useFakeTimers();
	const result = invitation({
		url: new URL(`https://test.local/invitation?invitation=${'x'.repeat(43)}`),
		locals: {},
		setHeaders: vi.fn()
	} as any) as any;
	expect(result).not.toBeInstanceOf(Promise);
	expect(result.preview).toBeNull();
	expect(result.previewRequest).toBeInstanceOf(Promise);
	await vi.advanceTimersByTimeAsync(15_001);
	expect(await result.previewRequest).toEqual({
		preview: null,
		error: 'Unable to load this invitation. Please try again.'
	});
});
