// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import type { FunctionReturnType } from 'convex/server';
import { expect, it, vi } from 'vitest';
import { api } from '../../../src/convex/_generated/api';
import schema from '../../../src/convex/schema';
import { AccountNavigation } from '../../../src/lib/auth/account-navigation';
import { AccountPreparation } from '../../../src/lib/auth/account-preparation';
import { identity, initializeViewer } from '../../support/contract-data';
const modules = import.meta.glob('../../../src/convex/**/*.*s');
function liveAccount(client: {
	query: (
		query: typeof api.accounts.viewer,
		args: {}
	) => Promise<FunctionReturnType<typeof api.accounts.viewer>>;
	mutation: (mutation: typeof api.profiles.initialize, args: {}) => Promise<null>;
}) {
	const preparation = new AccountPreparation();
	return async () => {
		const viewer = await client.query(api.accounts.viewer, {});
		await preparation.initialize(viewer, 1, () => client.mutation(api.profiles.initialize, {}));
		return client.query(api.accounts.viewer, {});
	};
}

it('navigates once for repeated requests to open the same account', async () => {
	let finish!: () => void;
	const navigate = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			})
	);
	const navigation = new AccountNavigation(navigate);
	const first = navigation.open('session', '/contracts/saved?tab=terms#clause');
	const second = navigation.open('session', '/');
	expect(second).toBe(first);
	await Promise.resolve();
	expect(navigate).toHaveBeenCalledExactlyOnceWith('/contracts/saved?tab=terms#clause');
	finish();
	await first;
	await navigation.open('session', '/');
	expect(navigate).toHaveBeenCalledTimes(1);
	const next = navigation.open('next-session', '//external.example');
	await Promise.resolve();
	expect(navigate).toHaveBeenLastCalledWith('/contracts');
	finish();
	await next;
});

it('reads returning accounts and provisions missing state once without restarting attribution', async () => {
	const t = convexTest(schema, modules).withIdentity(identity);
	await t.run(async (ctx) => {
		await initializeViewer(ctx);
	});
	const mutation = vi.fn(t.mutation.bind(t));
	const client = { query: t.query.bind(t), mutation };
	const prepare = liveAccount(client);
	expect((await prepare())?.needsInitialization).toBe(false);
	await prepare();
	expect(mutation).not.toHaveBeenCalled();
	const newAccount = t.withIdentity({
		...identity,
		subject: 'new_user',
		tokenIdentifier: identity.issuer + '|new_user',
		email: 'new@example.com'
	});
	const newMutation = vi.fn(newAccount.mutation.bind(newAccount));
	const newClient = { query: newAccount.query.bind(newAccount), mutation: newMutation };
	const prepareNew = liveAccount(newClient);
	const provisioned = await prepareNew();
	expect(Boolean(provisioned && !provisioned.needsInitialization)).toBe(true);
	await prepareNew();
	expect(newMutation).toHaveBeenCalledExactlyOnceWith(api.profiles.initialize, {});
});

it('scopes consolidated Home assistance to the authenticated membership and excludes advisory hints from admission', async () => {
	const t = convexTest(schema, modules).withIdentity(identity);
	await t.run(async (ctx) => {
		await initializeViewer(ctx);
	});
	const viewer = await t.query(api.accounts.viewer, {});
	expect(viewer).not.toHaveProperty('hasCreatedContract');
	expect(viewer).not.toHaveProperty('colleaguesInvited');
	const bootstrap = await t.query(api.accounts.homeBootstrap, {});
	expect(bootstrap.viewer).toEqual(viewer);
	const home = bootstrap.home!;
	expect(home.scope).toEqual({
		profileId: viewer!.profile.id,
		membershipId: viewer!.membership!.id,
		companyId: viewer!.company!.id
	});
	expect(home).toMatchObject({ search: '', cursor: null, numItems: 24 });
	const hints = await t.query(api.accounts.setupHints, {});
	expect(hints).toEqual({ complete: false, nextStep: 'template', contractId: null });
	expect(bootstrap.setup).toEqual({ membershipId: viewer!.membership!.id, progress: hints });
	await expect(
		t
			.withIdentity({ ...identity, subject: 'other', tokenIdentifier: 'other' })
			.query(api.accounts.setupHints, {})
	).rejects.toThrow();
});
