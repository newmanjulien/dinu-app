import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Id } from '../../src/convex/_generated/dataModel';
import { fetchWorkspaceRole } from '../../src/lib/auth/workspace-role-query';
import {
	readWorkspaceRole,
	rememberWorkspaceRole,
	type WorkspaceMembership
} from '../../src/lib/auth/workspace-role-storage';
import { WorkspaceRole } from '../../src/lib/auth/workspace-role.svelte';
import { page } from './navigation.svelte';
import Harness from './WorkspaceRoleHarness.svelte';

vi.mock('../../src/lib/auth/workspace-role-query', () => ({ fetchWorkspaceRole: vi.fn() }));

const admin: WorkspaceMembership = {
	membershipId: 'membership' as Id<'memberships'>,
	companyId: 'company' as Id<'company'>,
	role: 'admin'
};
const rep: WorkspaceMembership = { ...admin, role: 'rep' };
const fetchRole = vi.mocked(fetchWorkspaceRole);
const owners: WorkspaceRole[] = [];
let component: ReturnType<typeof mount> | undefined;

function resolver() {
	const owner = new WorkspaceRole();
	owners.push(owner);
	return owner;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => (resolve = accept));
	return { promise, resolve };
}

async function settle() {
	await vi.dynamicImportSettled();
	await vi.advanceTimersByTimeAsync(0);
	flushSync();
}

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	fetchRole.mockReset().mockResolvedValue(admin);
});

afterEach(async () => {
	if (component) await unmount(component);
	component = undefined;
	for (const owner of owners.splice(0)) owner.clear();
	vi.restoreAllMocks();
	localStorage.clear();
	document.body.innerHTML = '';
	vi.useRealTimers();
});

it('reuses a remembered role across logout and new sessions without fetching', async () => {
	rememberWorkspaceRole('user', admin);
	const owner = resolver();
	const getToken = vi.fn(async () => 'token');
	owner.prepare('user', 'session', 0, getToken);
	expect(owner.roleFor('user', 'session')).toBe('admin');
	expect(owner.roleFor('other-user', 'session')).toBeUndefined();
	expect(owner.roleFor('user', 'other-session')).toBeUndefined();
	owner.clear();
	expect(owner.roleFor('user', 'session')).toBeUndefined();
	const returning = resolver();
	returning.prepare('user', 'new-session', 0, getToken);
	await settle();
	expect(returning.roleFor('user', 'new-session')).toBe('admin');
	expect(getToken).not.toHaveBeenCalled();
	expect(fetchRole).not.toHaveBeenCalled();
});

it('fetches once for a missing hint and remembers the result', async () => {
	const owner = resolver();
	const getToken = vi.fn(async () => 'token');
	owner.prepare('user', 'session', 0, getToken);
	owner.prepare('user', 'session', 0, getToken);
	expect(owner.roleFor('user', 'session')).toBeUndefined();
	await settle();
	expect(getToken).toHaveBeenCalledTimes(1);
	expect(fetchRole).toHaveBeenCalledExactlyOnceWith('token', expect.any(AbortSignal));
	expect(owner.roleFor('user', 'session')).toBe('admin');
	expect(readWorkspaceRole('user')).toEqual(admin);
});

it('lets live membership replace a pending hint and clears it when membership disappears', async () => {
	const result = deferred<WorkspaceMembership>();
	fetchRole.mockReturnValueOnce(result.promise);
	const owner = resolver();
	owner.prepare('user', 'session', 0, async () => 'token');
	await settle();
	owner.confirm('user', 'session', rep);
	expect(fetchRole.mock.calls[0][1].aborted).toBe(true);
	result.resolve(admin);
	await settle();
	expect(owner.roleFor('user', 'session')).toBe('rep');
	expect(readWorkspaceRole('user')).toEqual(rep);
	owner.confirm('user', 'session', null);
	owner.prepare('user', 'session', 1, async () => 'token');
	await settle();
	expect(owner.roleFor('user', 'session')).toBeUndefined();
	expect(readWorkspaceRole('user')).toBeUndefined();
	expect(fetchRole).toHaveBeenCalledTimes(1);
});

it.each([
	['other-user', 'other-session'],
	['user', 'other-session']
])('ignores late results after switching to %s / %s', async (userId, sessionId) => {
	const result = deferred<WorkspaceMembership>();
	fetchRole.mockReturnValueOnce(result.promise).mockResolvedValueOnce(rep);
	const owner = resolver();
	owner.prepare('user', 'session', 0, async () => 'old-token');
	await settle();
	owner.prepare(userId, sessionId, 0, async () => 'new-token');
	await settle();
	result.resolve(admin);
	await settle();
	expect(owner.roleFor('user', 'session')).toBeUndefined();
	expect(owner.roleFor(userId, sessionId)).toBe('rep');
	expect(readWorkspaceRole(userId)).toEqual(rep);
	if (userId !== 'user') expect(readWorkspaceRole('user')).toBeUndefined();
});

it.each([
	['/(workspace)/contracts', 'Integrations', 'Contracts'],
	['/(workspace)/settings', 'Company name', 'Your name'],
	['/(workspace)/team', 'Pending invitations', 'Colleagues']
])(
	'uses the shared role for the %s skeleton and updates stale hints',
	(route, adminText, commonText) => {
		page.route.id = route;
		const owner = resolver();
		component = mount(Harness, { target: document.body, props: { owner } });
		flushSync();
		expect(document.body.textContent).not.toContain(adminText);
		rememberWorkspaceRole('user', admin);
		owner.prepare('user', 'session', 0, async () => 'token');
		flushSync();
		expect(document.body.textContent).toContain(adminText);
		owner.confirm('user', 'session', rep);
		flushSync();
		expect(document.body.textContent).not.toContain(adminText);
		expect(document.body.textContent).toContain(commonText);
		expect(readWorkspaceRole('user')).toEqual(rep);
		expect(fetchRole).not.toHaveBeenCalled();
	}
);
