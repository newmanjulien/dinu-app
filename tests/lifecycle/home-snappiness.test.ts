import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StartupData } from '../../src/lib/auth/startup-data';
import { csmState } from './csm-state.svelte';
import Harness from './HomeSnappinessHarness.svelte';
import { reactive } from './snappiness-observers.svelte';
import { frameClock, settle } from './snappiness-fixtures';
import { navigating, page } from './navigation.svelte';

const context = vi.hoisted(() => ({ query: undefined as unknown, cache: undefined as unknown }));
vi.mock('convex-svelte', () => ({
	useConvexClient: () => ({}),
	usePaginatedQuery: () => context.query
}));
vi.mock('$lib/contract/snapshot-cache', async (importOriginal) => ({
	...(await importOriginal<object>()),
	getContractSnapshotCache: () => context.cache
}));
vi.mock('$lib/components/workspace/IntegrationCatalog.svelte', () => import('./CsmChrome.svelte'));
vi.mock('$lib/components/workspace/HubSpotRelink.svelte', () => import('./CsmChrome.svelte'));
let component: ReturnType<typeof mount> | undefined;
let clock: ReturnType<typeof frameClock>;
let visibility: PropertyDescriptor | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	clock = frameClock();
	vi.stubGlobal('IntersectionObserver', undefined); // Exercise the supported visible-card fallback, without a browser.
	vi.stubGlobal('matchMedia', () => ({
		matches: true,
		addEventListener() {},
		removeEventListener() {}
	}));
	visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
	Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
	navigating.to = null;
	page.url = new URL('https://test.local/');
});
afterEach(async () => {
	if (component) await unmount(component);
	document.body.innerHTML = '';
	if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
	else Reflect.deleteProperty(document, 'visibilityState');
	vi.useRealTimers();
});
async function fixture() {
	const state = csmState();
	state.viewer.instructionsReady = true;
	state.session.workspaceAdmitted = true;
	const card = {
		_id: 'contract-a',
		buyerCompanyName: 'Synthetic Buyer',
		savedAt: 1,
		creator: { id: 'profile', name: 'Synthetic', avatarUrl: null }
	};
	const query = reactive({
		status: 'LoadingFirstPage',
		results: [] as (typeof card)[],
		error: undefined,
		loadMore: vi.fn()
	});
	const cache = {
		isDeleted: () => false,
		peek: () => undefined,
		pauseBackground: vi.fn(),
		allowBackground: vi.fn(),
		backgroundCandidates: vi.fn()
	};
	context.query = query;
	context.cache = cache;
	const startup = {
		sessionId: 'session',
		userId: 'user',
		viewer: state.viewer,
		contracts: { page: [card], isDone: true }
	} as unknown as StartupData;
	component = mount(Harness, { target: document.body, props: { state, startup } });
	await settle();
	return { query, card, cache };
}

it('displays startup contract cards while the live first-page query remains unresolved', async () => {
	const f = await fixture();
	expect(
		document.querySelector('a[aria-label="Open contract for Synthetic Buyer"]')
	).not.toBeNull();
	expect(f.query.status).toBe('LoadingFirstPage');
	expect(f.query.results).toEqual([]);
	expect(f.cache.allowBackground).not.toHaveBeenCalled();
});

it('allows visible-card warming only after live readiness and two paint frames, and pauses it during interaction', async () => {
	const f = await fixture();
	f.query.results = [f.card];
	f.query.status = 'Exhausted';
	await settle();
	expect(f.cache.allowBackground).not.toHaveBeenCalled();
	await clock.frame();
	expect(f.cache.allowBackground).not.toHaveBeenCalled();
	await clock.frame();
	await vi.advanceTimersByTimeAsync(100);
	await settle();
	expect(f.cache.allowBackground).toHaveBeenCalled();
	expect(f.cache.backgroundCandidates).toHaveBeenLastCalledWith(['contract-a']);
	const calls = f.cache.allowBackground.mock.calls.length;
	window.dispatchEvent(new Event('scroll'));
	await settle();
	expect(f.cache.pauseBackground).toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(249);
	await settle();
	expect(f.cache.allowBackground).toHaveBeenCalledTimes(calls);
	await vi.advanceTimersByTimeAsync(1);
	await settle();
	expect(f.cache.allowBackground.mock.calls.length).toBeGreaterThan(calls);
});

it('retains the displayed cards while a replacement search page is pending', async () => {
	const f = await fixture();
	f.query.results = [f.card];
	f.query.status = 'Exhausted';
	await settle();
	const card = document.querySelector('a[aria-label="Open contract for Synthetic Buyer"]');
	const input = document.querySelector<HTMLInputElement>('[aria-label="Search contracts"]')!;
	input.value = 'Another';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	f.query.status = 'LoadingFirstPage';
	f.query.results = [];
	await vi.advanceTimersByTimeAsync(200);
	await settle();
	expect(document.querySelector('a[aria-label="Open contract for Synthetic Buyer"]')).toBe(card);
	expect(document.body.textContent).not.toContain('No contracts');
});
