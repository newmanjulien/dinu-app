// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import type { FunctionReturnType } from 'convex/server';
import { convexTest } from 'convex-test';
import { expect, it, vi } from 'vitest';
import { AccountNavigation } from '../../src/lib/auth/account-navigation';
import { AccountPreparation } from '../../src/lib/auth/account-preparation';
import { api } from '../../src/convex/_generated/api';
import schema from '../../src/convex/schema';
import { identity, initializeViewer } from './fixtures';
const modules = import.meta.glob('../../src/convex/**/*.*s');
function liveAccount(client: {
	query: (
		query: typeof api.profiles.viewer,
		args: {}
	) => Promise<FunctionReturnType<typeof api.profiles.viewer>>;
	mutation: (mutation: typeof api.profiles.initialize, args: {}) => Promise<null>;
}) {
	const preparation = new AccountPreparation();
	return async () => {
		const viewer = await client.query(api.profiles.viewer, {});
		await preparation.initialize(viewer, 1, () => client.mutation(api.profiles.initialize, {}));
		return client.query(api.profiles.viewer, {});
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
	expect(navigate).toHaveBeenLastCalledWith('/');
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
	await t.run(async ({ db }) => {
		const company = await db.query('company').first();
		const baselineId = await db.insert('baselines', {
			companyId: company!._id,
			source: 'seed',
			state: 'prepared',
			fingerprint: 'staging',
			issues: [],
			blockCount: 0
		});
		await db.insert('currentTemplate', {
			baselineId,
			companyId: company!._id,
			maintenance: true
		});
	});
	const maintained = await prepare();
	expect(Boolean(maintained && !maintained.needsInitialization)).toBe(true);
	expect(maintained?.templateReady).toBe(false);
	expect(mutation).not.toHaveBeenCalled();
	expect(await t.run(({ db }) => db.system.query('_scheduled_functions').collect())).toHaveLength(
		0
	);
});
