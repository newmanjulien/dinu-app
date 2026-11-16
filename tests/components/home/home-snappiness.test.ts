import type { Id } from '../../../src/convex/_generated/dataModel';
import { mount, onDestroy, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StartupHome } from '../../../src/lib/auth/startup-data';
import type { StartupSetup } from '../../../src/lib/auth/startup-data';
import { WorkspaceReadSnapshots } from '../../../src/lib/auth/workspace-read-snapshots.svelte';
import type { WorkspaceDirectory } from '../../../src/lib/auth/workspace-read-storage';
import { csmState } from '../../support/csm-state.svelte';
import Harness from './HomeSnappinessHarness.svelte';
import { observe, reactive } from '../../support/observers.svelte';
import Contracts from '../../../src/lib/components/workspace/Contracts.svelte';
import { frameClock, settle } from '../../support/svelte';
import { navigating, page } from '../../support/navigation.svelte';

const context = vi.hoisted(() => ({
	query: undefined as unknown,
	buyerQuery: undefined as unknown,
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
		onDestroy(
			observe(args, (value) =>
				context.arguments.push({ kind: options.initialNumItems, args: value })
			)
		);
		return options.initialNumItems === 24 ? context.query : context.buyerQuery;
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
let reads: WorkspaceReadSnapshots | undefined;
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
	reads?.destroy();
	reads = undefined;
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
		owner?: boolean;
		returning?: boolean;
	} = {}
) {
	const state = csmState();
	state.viewer.instructionsReady = true;
	state.session.workspaceAdmitted = true;
	const card = {
		hasUnreadComment: false,
		_id: 'contract-a' as Id<'savedContracts'>,
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
		backgroundCandidates: vi.fn()
	};
	const buyerQuery = reactive({
		status: 'LoadingFirstPage',
		results: [] as {
			id: string;
			contractId: Id<'savedContracts'>;
			token: string;
			title: string;
			createdAt: number;
			hasUnreadComment: boolean;
		}[],
		error: undefined,
		loadMore: vi.fn()
	});
	let resolveModule!: (value: typeof Contracts) => void;
	let rejectModule!: (cause: Error) => void;
	const module = new Promise<typeof Contracts>((resolve, reject) => {
		resolveModule = resolve;
		rejectModule = reject;
	});
	context.load.mockReturnValue(module);
	if (!options.deferModule) resolveModule(Contracts);
	context.query = query;
	context.buyerQuery = buyerQuery;
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
	if (options.retained || options.owner) {
		const link = {
			id: 'link-a' as Id<'buyerLinks'>,
			contractId: card._id,
			token: 'Ab3Cd4Ef5Gh6I',
			title: card.title,
			createdAt: 1_000,
			hasUnreadComment: false
		};
		reads = new WorkspaceReadSnapshots(
			{
				profileId: state.viewer.profile.id,
				membershipId: state.viewer.membership.id,
				companyId: state.viewer.company.id
			},
			'user'
		);
		if (options.retained) {
			reads.rememberBrowse('contracts', '', [card], false);
			reads.rememberBrowse('buyerLinks', '', [link], false);
			reads.confirm('contracts', [card], false);
			reads.confirm('buyerLinks', [link], false);
		}
	}
	component = mount(Harness, {
		target: document.body,
		props: {
			state,
			startup: options.startup === false ? null : startup,
			setup,
			reads,
			returning: options.returning
		}
	});
	await settle();
	return { state, query, buyerQuery, card, cache, reads, resolveModule, rejectModule };
}

it('shows a scoped startup card before the live contracts page arrives', async () => {
	const f = await fixture();
	expect(document.querySelector('#contracts-heading')).not.toBeNull();
	expect(contractCard()).not.toBeNull();
	expect(f.query.status).toBe('LoadingFirstPage');
	expect(f.query.results).toEqual([]);
	expect(f.cache.allowBackground).not.toHaveBeenCalled();
});

it('warms visible contracts after live readiness and pauses during interaction', async () => {
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
	expect(f.cache.backgroundCandidates).toHaveBeenLastCalledWith(['contract-a'], []);
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

it('filters displayed cards immediately without declaring a final empty result while search is pending', async () => {
	const f = await fixture();
	f.query.results = [f.card];
	f.query.status = 'Exhausted';
	await settle();
	expect(contractCard()).not.toBeNull();
	const input = searchInput();
	input.value = 'Another';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	f.query.status = 'LoadingFirstPage';
	f.query.results = [];
	await vi.advanceTimersByTimeAsync(200);
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
	expect(contractCard()).toBeNull();
	f.query.results = [f.card];
	f.query.status = 'Exhausted';
	await vi.advanceTimersByTimeAsync(80);
	await settle();
	expect(contractCard()).not.toBeNull();
});

function searchInput() {
	return document.querySelector<HTMLInputElement>(
		'[aria-label="Search contracts and buyer links"]'
	)!;
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
	return document.querySelector('a[aria-label="Open contract for Synthetic Buyer"]');
}
function buyerLink() {
	return document.querySelector('a[aria-label^="Open buyer link for Synthetic Buyer"]');
}

it('stages a cold entry from toolbar to setup, headings, and then rows only when each is ready', async () => {
	const f = await fixture({}, { startup: false, setup: 'pending' });
	const input = searchInput();
	input.focus();
	expect(input.disabled).toBe(false);
	expect(document.querySelector('a[href="/contracts/new"]')).not.toBeNull();
	expect(document.querySelector('#contracts-heading')).toBeNull();
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
	expect(document.querySelector('#contracts-heading')).toBeNull();
	f.query.results = [f.card];
	f.query.status = 'Exhausted';
	await settle();
	expect(contractCard()).toBeNull();
	await clock.frame();
	await clock.frame();
	const heading = document.querySelector('#contracts-heading');
	expect(heading).not.toBeNull();
	expect(prompt!.compareDocumentPosition(heading!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	expect(contractCard()).toBeNull();
	expect(searchInput()).toBe(input);
	expect(document.activeElement).toBe(input);
	await vi.advanceTimersByTimeAsync(80);
	await settle();
	expect(contractCard()).not.toBeNull();
	expect(
		heading!.compareDocumentPosition(contractCard()!) & Node.DOCUMENT_POSITION_FOLLOWING
	).toBeTruthy();
	expect(searchInput()).toBe(input);
	expect(document.activeElement).toBe(input);
});

it('makes retained contracts usable for search before the results module or live page arrives', async () => {
	const f = await fixture({}, { startup: false, deferModule: true, retained: true });
	expect(contractCard()).not.toBeNull();
	expect(f.query.status).toBe('LoadingFirstPage');
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
	await vi.advanceTimersByTimeAsync(200);
	await settle();
	expect(contractRequests()).toEqual([{ membershipId: 'member', search: 'Missing' }]);
});

it('reveals saved contracts from a delayed directory read and searches them while live data is pending', async () => {
	const f = await fixture({}, { startup: false, deferModule: true, owner: true });
	expect(contractCard()).toBeNull();
	let completeRead!: (value: WorkspaceDirectory<'contracts'>) => void;
	const diskRead = new Promise<WorkspaceDirectory<'contracts'>>((resolve) => {
		completeRead = resolve;
	});
	vi.spyOn(f.reads!.storage, 'readDirectory').mockReturnValue(diskRead as never);
	const hydration = f.reads!.hydrateDirectory('contracts');
	expect(contractCard()).toBeNull();
	await vi.advanceTimersByTimeAsync(80);
	await settle();
	completeRead({ savedAt: Date.now(), rows: [f.card] });
	await hydration;
	await settle();
	expect(contractCard()).not.toBeNull();
	const input = searchInput();
	typeSearch(input, 'Synthetic');
	await settle();
	expect(contractCard()).not.toBeNull();
	typeSearch(input, 'Other');
	await settle();
	expect(contractCard()).toBeNull();
	expect(f.query.status).toBe('LoadingFirstPage');
});

it('shows retained rows together on return without the cold-entry staging', async () => {
	const f = await fixture({}, { startup: false, retained: true, returning: true });
	expect(document.querySelector('#contracts-heading')).not.toBeNull();
	expect(contractCard()).not.toBeNull();
	expect(document.querySelector('#buyer-links-heading')).not.toBeNull();
	expect(buyerLink()).not.toBeNull();
	expect(f.query.status).toBe('LoadingFirstPage');
	expect(f.buyerQuery.status).toBe('LoadingFirstPage');
	expect(document.body.textContent).not.toContain('Still getting your contracts');
});

it('reveals a newly available buyer-link heading before its delayed row', async () => {
	const f = await fixture({}, { startup: false });
	await vi.advanceTimersByTimeAsync(80);
	await settle();
	expect(document.querySelector('#buyer-links-heading')).toBeNull();
	f.buyerQuery.results = [
		{
			id: 'link-a',
			contractId: f.card._id,
			token: 'Ab3Cd4Ef5Gh6I',
			title: 'Synthetic Buyer',
			createdAt: 1_000,
			hasUnreadComment: false
		}
	];
	f.buyerQuery.status = 'Exhausted';
	await settle();
	expect(document.querySelector('#buyer-links-heading')).not.toBeNull();
	expect(buyerLink()).toBeNull();
	await clock.frame();
	await clock.frame();
	expect(buyerLink()).not.toBeNull();
});

it('admits independent contract and buyer-link reads with their required page sizes', async () => {
	await fixture({}, { startup: false });
	expect(contractRequests()).toEqual([{ membershipId: 'member', search: '' }]);
	expect(
		context.arguments.filter((entry) => entry.kind === 10).map((entry) => entry.args)
	).toContainEqual({
		membershipId: 'member',
		search: ''
	});
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
	expect(context.arguments).toContainEqual({ kind: 10, args: 'skip' });
	expect(document.body.textContent).not.toContain('No contracts');
	await vi.advanceTimersByTimeAsync(149);
	expect(contractRequests()).toEqual([]);
	await vi.advanceTimersByTimeAsync(1);
	await settle();
	expect(contractRequests()).toEqual([{ membershipId: 'member', search: 'Acme' }]);
	expect(searchInput()).toBe(input);
	expect(document.activeElement).toBe(input);
});

it('uses the already settled term when the module arrives after debounce', async () => {
	const f = await fixture({}, { deferModule: true });
	const input = searchInput();
	typeSearch(input, 'Buyer');
	await settle();
	await vi.advanceTimersByTimeAsync(200);
	f.resolveModule(Contracts);
	await settle();
	expect(contractRequests()).toEqual([{ membershipId: 'member', search: 'Buyer' }]);
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
	await vi.advanceTimersByTimeAsync(200);
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
	expect(contractRequests()).toEqual([{ membershipId: 'member', search: 'After failure' }]);
});

it('enables creation from real prerequisites while results code, contracts and links remain pending', async () => {
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
	expect(f.buyerQuery.status).toBe('LoadingFirstPage');
	expect(document.querySelector('a[href="/contracts/new"]')).not.toBeNull();
	f.state.session.blocked = true;
	await settle();
	expect(document.querySelector('a[href="/contracts/new"]')).toBeNull();
});
