// @vitest-environment edge-runtime
import { describe, expect, it, vi } from 'vitest';
import {
	api,
	internal,
	fixture,
	integrationClock,
	readyExport,
	events,
	currentContract,
	exportDelivery,
	claim,
	NOW,
	HOUR
} from '../../support/linked-contract';
import { sha256 } from '../../../src/convex/operationReceipts';
import { installQuotes, pushQuote } from './quote-fixtures';

integrationClock();

async function advance(
	f: Awaited<ReturnType<typeof fixture>>,
	id: import('../../../src/convex/_generated/dataModel').Id<'hubspotRemovals'>
) {
	for (let i = 0; i < 12; i++) {
		const removal = (await f.t.run(({ db }) => db.get('hubspotRemovals', id)))!;
		if (removal.done) return removal;
		if (removal.dueAt > Date.now()) vi.setSystemTime(removal.dueAt);
		await f.t.mutation(internal.hubspotUninstall.progress, { id });
		const updated = (await f.t.run(({ db }) => db.get('hubspotRemovals', id)))!;
		if (updated.phase === 'provider')
			await f.t.action(internal.hubspotUninstall.removeProvider, { id: updated.providerId });
	}
	throw new Error('Removal failed to finish');
}

describe('HubSpot removal and reinstallation', () => {
	it('retires queued activity and Quotes, releases attachment holds, preserves contracts, and does not replay after reinstall', async () => {
		const f = await fixture();
		await installQuotes(f);
		const push = await pushQuote(f);
		const output = await readyExport(f);
		const contract = await currentContract(f);
		const hash = await sha256('in-flight-oauth');
		await f.t.mutation(internal.hubspotOAuth.reserve, { hash });
		const stateId = await f.t.mutation(internal.hubspotOAuth.claim, { hash });
		const removalId = await f.t.mutation(api.hubspotUninstall.uninstall, {
			membershipId: f.owner.membershipId,
			connectionId: f.connectionId
		});
		expect(
			await f.t.mutation(api.hubspotUninstall.uninstall, {
				membershipId: f.owner.membershipId,
				connectionId: f.connectionId
			})
		).toBe(removalId);
		await expect(
			f.t.mutation(internal.hubspotOAuth.commit, {
				stateId,
				accountId: '12345',
				scopes: ['oauth'],
				tokens: { accessToken: 'stale', refreshToken: 'stale', expiresAt: NOW + HOUR }
			})
		).rejects.toThrow();
		const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
			expect(init?.method).toBe('DELETE');
			return new Response(null, { status: 204 });
		});
		vi.stubGlobal('fetch', fetcher);
		expect((await advance(f, removalId)).done).toBe(true);
		expect(await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId))).toBeNull();
		expect((await currentContract(f)).root.templateVersionId).toBe(contract.root.templateVersionId);
		expect((await events(f)).every((e) => e.status === 'retired')).toBe(true);
		expect(await f.t.run(({ db }) => db.get('hubspotQuotePushes', push.id))).toMatchObject({
			state: 'retired'
		});
		expect((await exportDelivery(f, output._id))?.attachmentUntil).toBeUndefined();
		expect(fetcher).toHaveBeenCalledTimes(1);
		await f.t.mutation(internal.hubspotOAuth.reserve, { hash: 'new-install' });
		const freshId = await f.t.mutation(internal.hubspotOAuth.claim, { hash: 'new-install' });
		await f.t.mutation(internal.hubspotOAuth.commit, {
			stateId: freshId,
			accountId: '12345',
			scopes: ['oauth'],
			tokens: { accessToken: 'new', refreshToken: 'new', expiresAt: Date.now() + HOUR }
		});
		await f.t.mutation(internal.hubspotDelivery.pump, { status: 'pending' });
		await f.t.mutation(internal.hubspotQuotes.pump, {});
		expect((await events(f)).every((e) => e.status === 'retired')).toBe(true);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('detaches a shared portal locally without deleting the provider installation used by another workspace', async () => {
		const f = await fixture();
		const otherId = await f.t.run(async ({ db }) => {
			const companyId = await db.insert('company', {
				name: 'Other workspace',
				ownerProfileId: f.rep.profileId
			});
			return db.insert('hubspotConnections', {
				companyId,
				accountId: '12345',
				generation: 1,
				accessToken: 'other-access',
				refreshToken: 'other-refresh',
				scopes: ['oauth'],
				status: 'connected',
				installedAt: NOW,
				expiresAt: NOW + HOUR,
				installerId: f.rep.profileId
			});
		});
		const before = await f.t.run(({ db }) => db.get('hubspotConnections', otherId));
		const id = await f.t.mutation(api.hubspotUninstall.uninstall, {
			membershipId: f.owner.membershipId,
			connectionId: f.connectionId
		});
		const removal = await advance(f, id);
		expect(
			await f.t.run(({ db }) => db.get('hubspotAccountRemovals', removal.providerId))
		).toMatchObject({ provider: 'shared', blocking: false });
		expect(await f.t.run(({ db }) => db.get('hubspotConnections', otherId))).toEqual(before);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('requires admin authority before changing the installation or retiring work', async () => {
		const f = await fixture();
		await expect(
			f.repClient.mutation(api.hubspotUninstall.uninstall, {
				membershipId: f.rep.membershipId,
				connectionId: f.connectionId
			})
		).rejects.toThrow('You do not have permission to perform this action.');
		expect(await f.t.run(({ db }) => db.query('hubspotRemovals').collect())).toEqual([]);
		expect(await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId))).toMatchObject({
			status: 'connected'
		});
	});

	it('waits for in-flight activity and refresh leases before deleting provider access and credentials', async () => {
		const f = await fixture();
		const running = await claim(f);
		await f.t.mutation(internal.hubspotConnections.claimRefresh, {
			id: f.connectionId,
			generation: 1,
			claim: 'refresh-owner'
		});
		const connection = (await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId)))!;
		const safeAfter = Math.max(running.leaseUntil!, connection.refreshUntil!) + 30_000;
		const id = await f.t.mutation(api.hubspotUninstall.uninstall, {
			membershipId: f.owner.membershipId,
			connectionId: f.connectionId
		});
		await f.t.mutation(internal.hubspotUninstall.progress, { id });
		await f.t.mutation(internal.hubspotUninstall.progress, { id });
		expect(await f.t.run(({ db }) => db.get('hubspotRemovals', id))).toMatchObject({
			phase: 'events',
			done: false
		});
		expect(await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId))).toMatchObject({
			status: 'retiring',
			accessToken: 'synthetic-access'
		});
		expect(fetch).not.toHaveBeenCalled();
		const fetcher = vi.fn(async () => {
			expect(Date.now()).toBeGreaterThanOrEqual(safeAfter);
			return new Response(null, { status: 204 });
		});
		vi.stubGlobal('fetch', fetcher);
		await advance(f, id);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId))).toBeNull();
	});

	it('never resends an ambiguous provider DELETE and blocks reinstall while retaining its removal evidence', async () => {
		const f = await fixture();
		const id = await f.t.mutation(api.hubspotUninstall.uninstall, {
			membershipId: f.owner.membershipId,
			connectionId: f.connectionId
		});
		const fetcher = vi.fn(async () => {
			throw new TypeError('DELETE response lost');
		});
		vi.stubGlobal('fetch', fetcher);
		const removal = await advance(f, id);
		expect(await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId))).toBeNull();
		expect(
			await f.t.run(({ db }) => db.get('hubspotAccountRemovals', removal.providerId))
		).toMatchObject({ provider: 'unknown', blocking: true });
		await expect(
			f.t.mutation(internal.hubspotOAuth.reserve, { hash: 'reinstall-too-soon' })
		).rejects.toThrow('removal is still being resolved');
		vi.setSystemTime(Date.now() + HOUR);
		await f.t.mutation(internal.hubspotUninstall.resume, {});
		await f.t.mutation(internal.hubspotUninstall.recoverProvider, { id: removal.providerId });
		await f.t.action(internal.hubspotUninstall.removeProvider, { id: removal.providerId });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
