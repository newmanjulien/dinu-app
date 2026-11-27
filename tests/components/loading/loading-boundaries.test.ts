import type { AccountViewer } from '../../../src/lib/auth/viewer-session.svelte';
import type { Id } from '../../../src/convex/_generated/dataModel';
import { mount, unmount, hydrate } from 'svelte';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { readFileSync, existsSync } from 'node:fs';
import { reactive } from '../../support/observers.svelte';
import { settle } from '../../support/svelte';
import { page } from '../../support/navigation.svelte';
import Harness from './LoadingHarness.svelte';

const external = vi.hoisted(() => ({
	clerk: undefined as any,
	clients: [] as any[],
	authenticate: undefined as undefined | ((value: boolean) => void)
}));
vi.mock('svelte-clerk', () => ({ useClerkContext: () => external.clerk }));
vi.mock('$lib/auth/SessionStatus.svelte', () => import('../../support/CsmChrome.svelte'));
// Optional route prefetch is outside this provider-composition test.
vi.mock('$lib/auth/destination-code', () => ({ preloadDestination: async () => {} }));
vi.mock('convex/browser', () => ({
	ConvexClient: class {
		closed = false;
		queries = new Map<string, unknown>();
		reads: {
			name: string;
			receive: (value: unknown) => void;
			fail: (error: Error) => void;
			active: boolean;
		}[] = [];
		client = {
			localQueryResult: (name: string) => {
				const value = this.queries.get(name);
				if (value instanceof Error) throw value;
				return value;
			}
		};
		mutation = vi.fn(async () => null);
		constructor() {
			external.clients.push(this);
		}
		setAuth(_token: unknown, accepted: (value: boolean) => void) {
			external.authenticate = accepted;
		}
		onUpdate(
			ref: any,
			_args: unknown,
			receive: (value: unknown) => void,
			fail: (error: Error) => void
		) {
			const read = { name: getFunctionName(ref), receive, fail, active: true };
			this.reads.push(read);
			return () => {
				read.active = false;
			};
		}
		deliver(name: string, value: unknown) {
			this.queries.set(name, value);
			for (const read of this.reads.filter((r) => r.active && r.name === name))
				value instanceof Error ? read.fail(value) : read.receive(value);
		}
		close() {
			this.closed = true;
			return Promise.resolve();
		}
	}
}));
let component: ReturnType<typeof mount> | undefined;
const viewer = (): NonNullable<AccountViewer> => ({
	profile: {
		id: 'profile' as Id<'profiles'>,
		email: 'private@example.com',
		name: 'Private',
		avatarUrl: null
	},
	membership: {
		id: 'member' as Id<'memberships'>,
		companyId: 'company' as Id<'company'>,
		role: 'admin',
		isOwner: true
	},
	company: {
		id: 'company' as Id<'company'>,
		name: 'Private company',
		avatarUrl: null,
		approvalEmail: null,
		templateSource: null,
		setupCall: null,
		deletion: null
	},
	permissions: {
		editCompanyProfile: true,
		manageMembers: true,
		manageTemplate: true,
		manageIntegrations: true,
		manageOwnership: true
	},
	needsInitialization: false,
	templateReady: true,
	instructionsReady: true
});
beforeEach(() => {
	vi.useFakeTimers();
	external.clients = [];
	external.authenticate = undefined;
	external.clerk = reactive({
		isLoaded: false,
		auth: { sessionId: undefined, userId: undefined },
		session: undefined,
		user: undefined
	});
	page.url = new URL('https://test.local/contracts');
	page.route.id = '/(workspace)/contracts';
	page.data = {};
});
afterEach(async () => {
	if (component) await unmount(component);
	component = undefined;
	document.body.innerHTML = '';
	vi.useRealTimers();
});
async function login() {
	external.clerk.auth = { sessionId: 'session', userId: 'user' };
	external.clerk.session = { id: 'session', getToken: async () => 'token' };
	external.clerk.user = { id: 'user' };
	external.clerk.isLoaded = true;
	await settle();
	await vi.waitFor(() => expect(external.authenticate).toBeTypeOf('function'));
}
it('shows the Contracts frame before Clerk/auth/viewer settle without replacing the public tree', async () => {
	component = mount(Harness, { target: document.body });
	await settle();
	const frame = document.querySelector('[data-workspace-frame]');
	expect(frame).not.toBeNull();
	expect(frame?.querySelector('[role="status"]')).not.toBeNull();
	expect(document.querySelector('[data-private-content]')).toBeNull();
	await login();
	expect(document.querySelector('[data-workspace-frame]')).toBe(frame);
	const queuedClient = external.clients.at(-1)!;
	expect(queuedClient.reads.filter((r: any) => r.active).map((r: any) => r.name)).toEqual([
		'accounts:viewer',
		'contracts:home'
	]);
	queuedClient.deliver('accounts:viewer', viewer());
	await settle();
	expect(document.querySelector('[data-private-content]')).toBeNull();
	external.authenticate!(true);
	await settle();
	const client = external.clients.at(-1)!;
	await vi.waitFor(() =>
		expect(client.reads.filter((r: any) => r.active).map((r: any) => r.name)).toEqual([
			'accounts:viewer',
			'contracts:home',
			'accounts:setupHints'
		])
	);
	client.deliver('accounts:viewer', viewer());
	await settle();
	await vi.waitFor(() => expect(document.querySelector('[data-private-content]')).not.toBeNull());
	expect(document.querySelector('[data-workspace-frame]')).toBe(frame);
	expect(document.body.textContent).toContain('private@example.com');
	expect(client.mutation).not.toHaveBeenCalled();
});
it('preserves the entry form and typed value when the authenticated driver mounts', async () => {
	page.url = new URL('https://test.local/login');
	page.route.id = '/(entry)/login';
	component = mount(Harness, { target: document.body, props: { entry: true } });
	await settle();
	const input = document.querySelector('input')!;
	input.value = 'typed@example.com';
	page.url = new URL('https://test.local/onboarding');
	await login();
	expect(document.querySelector('input')).toBe(input);
	expect(input.value).toBe('typed@example.com');
});
it('bounds a local never-settling read, retries its subscription and retains its form', async () => {
	component = mount(Harness, { target: document.body });
	await login();
	external.authenticate!(true);
	await settle();
	const client = external.clients.at(-1)!;
	client.deliver('accounts:viewer', viewer());
	await settle();
	await vi.waitFor(() =>
		expect(document.querySelector('[aria-label="Private draft"]')).not.toBeNull()
	);
	const input = document.querySelector('[aria-label="Private draft"]') as HTMLInputElement;
	input.value = 'retained';
	await vi.advanceTimersByTimeAsync(15_001);
	await settle();
	expect(document.body.textContent).toContain('Read failed');
	const obsolete = client.reads.filter((r: any) => r.name === 'accounts:setupHints').at(-1);
	(document.querySelector('[role="alert"] button') as HTMLButtonElement).click();
	await settle();
	expect(client.reads.filter((r: any) => r.name === 'accounts:setupHints')).toHaveLength(2);
	obsolete.receive({ hasCreatedContract: false, contractToCopyId: null, colleaguesInvited: false });
	await settle();
	expect(document.body.textContent).not.toContain('Suggestions ready');
	client.deliver('accounts:setupHints', {
		hasCreatedContract: true,
		contractToCopyId: null,
		colleaguesInvited: true
	});
	await settle();
	expect(document.body.textContent).toContain('Suggestions ready');
	expect(document.querySelector('[aria-label="Private draft"]')).toBe(input);
	expect(input.value).toBe('retained');
	client.deliver('accounts:viewer', null);
	await settle();
	expect(document.querySelector('[data-private-content]')).toBeNull();
});
it('hydrates the exact server-produced pending frame without replacing it', async () => {
	const file = '.svelte-kit/loading-fixtures/workspace.html';
	if (!existsSync(file)) throw new Error('Run test:loading:ssr before test:lifecycle.');
	document.body.innerHTML = readFileSync(file, 'utf8');
	const frame = document.querySelector('[data-workspace-frame]');
	const warn = vi.spyOn(console, 'warn');
	component = hydrate(Harness, { target: document.body });
	await settle();
	expect(document.querySelector('[data-workspace-frame]')).toBe(frame);
	expect(warn).not.toHaveBeenCalled();
});

it.each([true, false])(
	'accepts only matching first-transport account assistance while the live viewer is pending (matches=%s)',
	async (matches) => {
		page.data = {
			startup: Promise.resolve({
				viewer: viewer(),
				sessionId: 'session',
				userId: matches ? 'user' : 'different-user'
			})
		};
		component = mount(Harness, { target: document.body });
		await login();
		external.authenticate!(true);
		await settle();
		if (matches)
			await vi.waitFor(() =>
				expect(document.querySelector('[data-private-content]')).not.toBeNull()
			);
		else expect(document.querySelector('[data-private-content]')).toBeNull();
		expect(external.clients.at(-1).mutation).not.toHaveBeenCalled();
	}
);
