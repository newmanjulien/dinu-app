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
it('returns Contracts HTML data immediately and lets the account settle while cards never settle', async () => {
	vi.useFakeTimers();
	const result = home({
		locals: { auth: () => ({ sessionId: 's', userId: 'u', getToken: async () => 't' }) },
		isDataRequest: false
	} as any) as any;
	expect(result).not.toBeInstanceOf(Promise);
	await Promise.resolve();
	await Promise.resolve();
	expect([...requests.pending.keys()]).toEqual(['accounts:viewer', 'accounts:startupHome']);
	requests.pending.get('accounts:viewer')!.resolve(null);
	expect(await result.startup).toEqual({ viewer: null, userId: 'u', sessionId: 's' });
	expect(requests.pending.get('accounts:startupHome')!.signal.aborted).toBe(false);
	await vi.advanceTimersByTimeAsync(5_001);
	expect(await result.startupHome).toBeNull();
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
