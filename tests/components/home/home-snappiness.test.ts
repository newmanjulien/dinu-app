import type { Id } from '../../../src/convex/_generated/dataModel';
import { mount, onDestroy, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StartupHome } from '../../../src/lib/auth/startup-data';
import type { StartupSetup } from '../../../src/lib/auth/startup-data';
import type { WorkspaceLists } from '../../../src/lib/auth/workspace-lists.svelte';
import { csmState } from '../../support/csm-state.svelte';
import Harness from './HomeSnappinessHarness.svelte';
import { observe, reactive } from '../../support/observers.svelte';
import Contracts from '../../../src/lib/components/workspace/Contracts.svelte';
import { frameClock, settle } from '../../support/svelte';
import { navigating, page } from '../../support/navigation.svelte';

const context = vi.hoisted(() => ({
	query: undefined as unknown,
	cache: undefined as unknown,
	setup: undefined as unknown,
	load: vi.fn(),
	arguments: [] as { kind: number; args: 'skip' | { membershipId: string; search?: string } }[]
}));
vi.mock('$lib/components/workspace/contracts', () => ({
	getContracts: () => undefined,
	loadContracts: () => context.load()
}));
vi.mock('convex-svelte', () => ({
	useConvexClient: () => ({}),
	usePaginatedQuery: (
		_ref: unknown,
		args: () => 'skip' | { membershipId: string; search?: string },
		options: { initialNumItems: number }
	) => {
		const pager = context.query as {
			status: string;
			results: unknown[];
			error: unknown;
			loadMore: (numItems: number) => void;
		};
		let previous: string | undefined;
		onDestroy(
			observe(args, (value) => {
				context.arguments.push({ kind: options.initialNumItems, args: value });
				const key = JSON.stringify(value);
				if (key === previous) return;
				previous = key;
				if (value !== 'skip') {
					pager.status = 'LoadingFirstPage';
					pager.results = [];
				}
			})
		);
		return {
			// The installed SDK rebuilds its aggregate array on reads, including status updates.
			get results() {
				return [...pager.results];
			},
			get status() {
				return pager.status;
			},
			get error() {
				return pager.error;
			},
			loadMore: (numItems: number) => {
				pager.status = 'LoadingMore';
				pager.loadMore(numItems);
			}
		};
	},
	useQuery: () => ({ data: undefined, error: undefined, isLoading: false })
}));
vi.mock('$lib/contract/snapshot-cache', async (importOriginal) => ({
	...(await importOriginal<object>()),
	getContractSnapshotCache: () => context.cache
}));
vi.mock('$lib/auth/read-query.svelte', () => ({
	useReadQuery: () => context.setup
}));
vi.mock(
	'$lib/components/workspace/IntegrationCatalog.svelte',
	() => import('../../support/CsmChrome.svelte')
);
vi.mock(
	'$lib/components/workspace/HubSpotRelink.svelte',
	() => import('../../support/CsmChrome.svelte')
);
let component: ReturnType<typeof mount> | undefined;
let clock: ReturnType<typeof frameClock>;
let visibility: PropertyDescriptor | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	context.arguments = [];
	context.load.mockReset();
	context.setup = reactive({
		data: undefined as unknown,
		error: undefined,
		isLoading: true,
		retry: vi.fn()
	});
	clock = frameClock();
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
	);
	vi.stubGlobal('IntersectionObserver', undefined); // Exercise the supported visible-card fallback, without a browser.
	vi.stubGlobal('matchMedia', () => ({
		matches: true,
		addEventListener() {},
		removeEventListener() {}
	}));
	visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
	Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
	navigating.to = null;
	page.url = new URL('https://test.local/contracts');
});
afterEach(async () => {
	if (component) await unmount(component);
	document.body.innerHTML = '';
	if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
	else Reflect.deleteProperty(document, 'visibilityState');
	vi.useRealTimers();
});
async function fixture(
	scope: Partial<NonNullable<StartupHome>['scope']> = {},
	options: {
		deferModule?: boolean;
		startup?: boolean;
		setup?: 'complete' | 'pending' | 'integrations';
		retained?: boolean;
		returning?: boolean;
	} = {}
) {
	const state = csmState();
	state.viewer.instructionsReady = true;
	state.session.workspaceAdmitted = true;
	const card = {
		hasUnreadComment: false,
		buyerLinkToken: null as string | null,
		_id: 'contract-a' as Id<'savedContracts'>,
		templateVersionId: 'version-a' as Id<'templateVersions'>,
		title: 'Synthetic Buyer',
		_creationTime: 1,
		hubspot: undefined,
		workBlock: null,
		savedAt: 1,
		creator: { name: 'Synthetic', avatarUrl: null }
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
		suspendBackground: vi.fn(),
		allowBackground: vi.fn(),
		backgroundCandidates: vi.fn(),
		hint: vi.fn(),
		loadFrozenVersion: vi.fn().mockResolvedValue({})
	};
	let resolveModule!: (value: typeof Contracts) => void;
	let rejectModule!: (cause: Error) => void;
	const module = new Promise<typeof Contracts>((resolve, reject) => {
		resolveModule = resolve;
		rejectModule = reject;
	});
	context.load.mockReturnValue(module);
	if (!options.deferModule) resolveModule(Contracts);
	context.query = query;
	context.cache = cache;
	const startup: StartupHome = {
		sessionId: 'session',
		userId: 'user',
		scope: {
			profileId: state.viewer.profile.id,
			membershipId: state.viewer.membership.id,
			companyId: state.viewer.company.id,
			...scope
		},
		search: '',
		cursor: null,
		numItems: 24,
		contracts: { page: [card], isDone: true, continueCursor: '' }
	};
	const setup: StartupSetup | null =
		options.setup === 'pending'
			? null
			: {
					sessionId: 'session',
					userId: 'user',
					membershipId: state.viewer.membership.id,
					progress:
						options.setup === 'integrations'
							? { complete: false, nextStep: 'integrations', contractId: null }
							: { complete: true, nextStep: null, contractId: null }
				};
	if (options.retained) {
		query.results = [card];
		query.status = 'Exhausted';
	}
	const home = {
		get data() {
			return query.status !== 'LoadingFirstPage' && !query.error
				? { page: query.results, isDone: query.status === 'Exhausted', continueCursor: '' }
				: undefined;
		},
		get currentData() {
			return this.data;
		},
		get error() {
			return query.error;
		},
		get rejected() {
			return Boolean(query.error);
		},
		get isLoading() {
			return query.status === 'LoadingFirstPage';
		},
		get isStale() {
			return false;
		},
		retry: vi.fn()
	};
	const unusedTeam = {
		results: [],
		status: 'LoadingFirstPage' as const,
		isLoading: true,
		error: undefined,
		loadMore: vi.fn()
	};
	const lists: WorkspaceLists = {
		home,
		colleagues: unusedTeam,
		invitations: unusedTeam,
		openTeam: vi.fn(),
		retryColleagues: vi.fn(),
		retryInvitations: vi.fn()
	};
	const startupData = reactive({ home: options.startup === false ? null : startup });
	component = mount(Harness, {
		target: document.body,
		props: {
			state,
			get startup() {
				return startupData.home;
			},
			setup,
			lists,
			returning: options.returning
		}
	});
	await settle();
	return {
		state,
		query,
		card,
		cache,
		lists,
		resolveModule,
		provideStartup: () => (startupData.home = startup),
		rejectModule
	};
}

async function revealFirstVisit() {
	await clock.frame();
	await clock.frame();
	await settle();
}

it('shows a scoped startup card before the live contracts page arrives', async () => {
	const f = await fixture();
	expect(document.querySelector('#contracts-heading')).not.toBeNull();
	expect(contractCard()).toBeNull();
	await revealFirstVisit();
	expect(contractCard()).not.toBeNull();
	expect(f.query.status).toBe('LoadingFirstPage');
	expect(f.query.results).toEqual([]);
	expect(f.cache.allowBackground).not.toHaveBeenCalled();
});

it('warms the shared template on idle without per-card state reads and pauses during interaction', async () => {
	const f = await fixture();
	await revealFirstVisit();
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
	expect(f.cache.backgroundCandidates).toHaveBeenLastCalledWith([], []);
	expect(f.cache.loadFrozenVersion).toHaveBeenCalledTimes(1);
	expect(f.cache.loadFrozenVersion).toHaveBeenCalledWith(
		f.card.templateVersionId,
		f.state.viewer.company.id
	);
	const calls = f.cache.allowBackground.mock.calls.length;
	window.dispatchEvent(new Event('scroll'));
	await settle();
	expect(f.cache.suspendBackground).toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(249);
	await settle();
	expect(f.cache.allowBackground).toHaveBeenCalledTimes(calls);
	await vi.advanceTimersByTimeAsync(1);
	await settle();
	expect(f.cache.allowBackground.mock.calls.length).toBeGreaterThan(calls);
});

it('hides unmatched displayed cards immediately without declaring a final empty result while search is pending', async () => {
	const f = await fixture();
	await revealFirstVisit();
	f.query.results = [f.card];
	f.query.status = 'Exhausted';
	await settle();
	expect(contractCard()).not.toBeNull();
	const input = searchInput();
	input.value = 'Another';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	f.query.status = 'LoadingFirstPage';
	f.query.results = [];
	await settle();
	expect(contractCard()).toBeNull();
	expect(document.body.textContent).not.toContain('No contracts');
});

it.each([
	{ companyId: 'another-company' as Id<'company'> },
	{ membershipId: 'another-membership' as Id<'memberships'> },
	{ profileId: 'another-profile' as Id<'profiles'> }
])('ignores startup cards with mismatched scope %o', async (scope) => {
	const f = await fixture(scope);
	await revealFirstVisit();
	expect(contractCard()).toBeNull();
	f.query.results = [f.card];
	f.query.status = 'Exhausted';
	await settle();
	expect(contractCard()).not.toBeNull();
});

function searchInput() {
	return document.querySelector<HTMLInputElement>('[aria-label="Search contracts"]')!;
}
function typeSearch(input: HTMLInputElement, value: string) {
	input.focus();
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
}
function contractRequests() {
	return context.arguments
		.filter((entry) => entry.kind === 24 && entry.args !== 'skip')
		.map((entry) => entry.args);
}
function contractCard() {
	return document.querySelector('a[aria-label^="Open contract for Synthetic Buyer"]');
}

it('stages a cold entry from toolbar to setup, headings, and then rows only when each is ready', async () => {
	const f = await fixture({}, { startup: false, setup: 'pending' });
	const input = searchInput();
	input.focus();
	expect(input.disabled).toBe(false);
	expect(document.querySelector('a[href="/contracts/new"]')).not.toBeNull();
	const heading = document.querySelector('#contracts-heading');
	expect(heading).not.toBeNull();
	expect(contractCard()).toBeNull();
	expect(document.body.textContent).not.toContain('Loading contracts');
	expect(document.body.textContent).not.toContain('No contracts');
	expect(document.querySelectorAll('.contracts article[aria-hidden="true"]')).toHaveLength(0);

	(context.setup as { data: unknown }).data = {
		complete: false,
		nextStep: 'integrations',
		contractId: null
	};
	await settle();
	const prompt = document.querySelector('a[href="/integrations"]');
	expect(prompt?.textContent).toBe('Explore integrations');
	expect(prompt!.compareDocumentPosition(heading!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	f.query.results = [f.card];
	f.query.status = 'Exhausted';
	await settle();
	expect(contractCard()).toBeNull();
	expect(searchInput()).toBe(input);
	expect(document.activeElement).toBe(input);
	await revealFirstVisit();
	expect(contractCard()).not.toBeNull();
	expect(
		heading!.compareDocumentPosition(contractCard()!) & Node.DOCUMENT_POSITION_FOLLOWING
	).toBeTruthy();
	expect(searchInput()).toBe(input);
	expect(document.activeElement).toBe(input);
});

it('filters the hoisted live Home list before the results module or search page arrives', async () => {
	const f = await fixture({}, { startup: false, deferModule: true, retained: true });
	expect(contractCard()).toBeNull();
	await revealFirstVisit();
	expect(contractCard()).not.toBeNull();
	expect(f.query.status).toBe('Exhausted');
	const input = searchInput();
	typeSearch(input, '  synthetic  ');
	await settle();
	expect(contractCard()).not.toBeNull();
	typeSearch(input, 'Missing');
	await settle();
	expect(contractCard()).toBeNull();
	expect(searchInput()).toBe(input);
	expect(document.activeElement).toBe(input);
	expect(document.body.textContent).not.toContain('No contracts');
	f.resolveModule(Contracts);
	await vi.advanceTimersByTimeAsync(500);
	await settle();
	expect(contractRequests()).toEqual([{ search: 'Missing' }]);
});

it('reveals a delayed scoped startup page and filters matching titles while live search is pending', async () => {
	const f = await fixture({}, { startup: false, deferModule: true });
	expect(contractCard()).toBeNull();
	await revealFirstVisit();
	f.provideStartup();
	await settle();
	expect(contractCard()).not.toBeNull();

	const input = searchInput();
	typeSearch(input, 'Synthetic');
	await settle();
	expect(contractCard()).not.toBeNull();
	typeSearch(input, 'Other');
	await settle();
	expect(contractCard()).toBeNull();
	expect(document.body.textContent).not.toContain('No contracts');
	expect(f.query.status).toBe('LoadingFirstPage');
});

it('shows hoisted live rows together on return without the cold-entry staging', async () => {
	const f = await fixture({}, { startup: false, retained: true, returning: true });
	expect(document.querySelector('#contracts-heading')).not.toBeNull();
	expect(contractCard()).not.toBeNull();
	expect(f.query.status).toBe('Exhausted');
	expect(document.body.textContent).not.toContain('Still getting your contracts');
});

it('uses the hoisted plain Home query and skips duplicate empty browse reads', async () => {
	const f = await fixture({}, { startup: false, retained: true });
	expect(contractRequests()).toEqual([]);
	expect(f.lists.home.currentData?.page).toEqual([f.card]);
});

it('keeps the actual focused input through module arrival and skips empty browse until pre-arrival typing settles', async () => {
	const f = await fixture({}, { deferModule: true, startup: false });
	const input = searchInput();
	expect(input.disabled).toBe(false);
	expect(document.querySelectorAll('.contracts article[aria-hidden="true"]')).toHaveLength(0);
	typeSearch(input, '  Acme  ');
	await settle();
	await vi.advanceTimersByTimeAsync(50);
	f.resolveModule(Contracts);
	await settle();
	expect(searchInput()).toBe(input);
	expect(document.activeElement).toBe(input);
	expect(input.value).toBe('  Acme  ');
	expect(context.arguments).toContainEqual({ kind: 24, args: 'skip' });
	expect(contractRequests()).toEqual([]);
	expect(document.body.textContent).not.toContain('No contracts');
	await vi.advanceTimersByTimeAsync(449);
	expect(contractRequests()).toEqual([]);
	await vi.advanceTimersByTimeAsync(1);
	await settle();
	expect(contractRequests()).toEqual([{ search: 'Acme' }]);
	expect(searchInput()).toBe(input);
	expect(document.activeElement).toBe(input);
});

it('uses the already settled term when the module arrives after debounce', async () => {
	const f = await fixture({}, { deferModule: true });
	const input = searchInput();
	typeSearch(input, 'Buyer');
	await settle();
	await vi.advanceTimersByTimeAsync(500);
	f.resolveModule(Contracts);
	await settle();
	expect(contractRequests()).toEqual([{ search: 'Buyer' }]);
	expect(searchInput()).toBe(input);
	expect(document.activeElement).toBe(input);
});

it('retains the same usable focused input, value and query across failed module download and retry', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const f = await fixture({}, { deferModule: true, startup: false });
	const input = searchInput();
	typeSearch(input, 'Before');
	await settle();
	f.rejectModule(new Error('download failed'));
	await settle();
	expect(document.body.textContent).toContain('We couldn’t load your contracts.');
	expect(searchInput()).toBe(input);
	expect(document.activeElement).toBe(input);
	typeSearch(input, 'After failure');
	await settle();
	await vi.advanceTimersByTimeAsync(500);
	context.load.mockResolvedValue(Contracts);
	const retry = [...document.querySelectorAll('button')].find(
		(button) => button.textContent === 'Try again'
	)!;
	retry.click();
	await settle();
	expect(context.load).toHaveBeenCalledTimes(2);
	expect(searchInput()).toBe(input);
	expect(document.activeElement).toBe(input);
	expect(input.value).toBe('After failure');
	expect(contractRequests()).toEqual([{ search: 'After failure' }]);
});

it('enables creation from real prerequisites while results code and contracts remain pending', async () => {
	const f = await fixture({}, { deferModule: true, startup: false });
	f.state.viewer.instructionsReady = false;
	await settle();
	expect(document.querySelector('a[href="/contracts/new"]')).toBeNull();
	f.state.viewer.instructionsReady = true;
	f.state.session.workspaceAdmitted = false;
	await settle();
	expect(document.querySelector('a[href="/contracts/new"]')).toBeNull();
	f.state.session.workspaceAdmitted = true;
	await settle();
	expect(document.querySelector('a[href="/contracts/new"]')).not.toBeNull();
	expect(context.arguments).toEqual([]);
	f.resolveModule(Contracts);
	await settle();
	expect(f.query.status).toBe('LoadingFirstPage');
	expect(document.querySelector('a[href="/contracts/new"]')).not.toBeNull();
	f.state.session.blocked = true;
	await settle();
	expect(document.querySelector('a[href="/contracts/new"]')).toBeNull();
});
