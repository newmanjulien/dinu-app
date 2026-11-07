// @vitest-environment edge-runtime
import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '../../src/convex/hubspotRecords';
import {
	api,
	internal,
	fixture,
	identity,
	integrationClock,
	readyExport,
	NOW,
	HOUR,
	json,
	markUnavailable
} from './fixtures';

integrationClock();
async function outsider(f: Awaited<ReturnType<typeof fixture>>) {
	const auth = {
		...identity,
		subject: 'outside',
		tokenIdentifier: 'outside',
		email: 'outside@example.com'
	};
	const membershipId = await f.t.run(async ({ db }) => {
		const profileId = await db.insert('profiles', {
			identity: auth.tokenIdentifier,
			issuer: auth.issuer,
			clerkId: auth.subject,
			email: auth.email,
			name: 'Outside'
		});
		const companyId = await db.insert('company', {
			name: 'Other company',
			ownerProfileId: profileId
		});
		return db.insert('memberships', { companyId, profileId, role: 'admin' });
	});
	return { client: f.root.withIdentity(auth), membershipId };
}
const tokens = {
	accessToken: 'replacement-synthetic',
	refreshToken: 'replacement-refresh',
	expiresAt: NOW + 48 * HOUR
};
async function reservedState(f: Awaited<ReturnType<typeof fixture>>, state = 'state-one') {
	const hash = await sha256(state);
	await f.t.mutation(internal.hubspotOAuth.reserve, { hash });
	return { hash, id: await f.t.mutation(internal.hubspotOAuth.claim, { hash }) };
}

describe('integration authorization', () => {
	it('refuses unauthenticated and forged-membership deal reads before any network call', async () => {
		const f = await fixture(),
			other = await outsider(f);
		const fetcher = vi.fn();
		vi.stubGlobal('fetch', fetcher);
		const args = { membershipId: f.owner.membershipId, search: '' };
		await expect(f.root.action(api.hubspotDeals.list, args)).rejects.toThrow('Sign in');
		await expect(other.client.action(api.hubspotDeals.list, args)).rejects.toThrow('access');
		await expect(
			f.t.action(api.hubspotDeals.list, { ...args, membershipId: other.membershipId })
		).rejects.toThrow('access');
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('refuses another company’s relink and export acknowledgment/release without modifying its records', async () => {
		const f = await fixture(),
			other = await outsider(f),
			attempt = await readyExport(f);
		await markUnavailable(f);
		const before = await f.t.run(({ db }) => db.get('savedContracts', f.id));
		await expect(
			other.client.mutation(internal.hubspotDeals.commit, {
				...f.creation,
				membershipId: other.membershipId,
				contractId: f.id,
				expectedGeneration: 1,
				dealId: '202',
				operationId: 'foreign'
			})
		).rejects.toThrow('changed');
		// Even valid credentials for the caller's own company cannot authorize a foreign contract.
		const otherConnection = await other.client.run(async ({ db }) => {
			const membership = (await db.get('memberships', other.membershipId))!;
			return db.insert('hubspotConnections', {
				companyId: membership.companyId,
				accountId: '999',
				generation: 1,
				accessToken: 'outside-synthetic',
				refreshToken: 'outside-synthetic',
				expiresAt: NOW + HOUR,
				scopes: [],
				installerId: membership.profileId,
				installedAt: NOW,
				status: 'connected'
			});
		});
		await expect(
			other.client.mutation(internal.hubspotDeals.commit, {
				...f.creation,
				membershipId: other.membershipId,
				connectionId: otherConnection,
				contractId: f.id,
				expectedGeneration: 1,
				dealId: '202',
				operationId: 'foreign-own-credentials'
			})
		).rejects.toThrow('deleted');
		await expect(
			other.client.mutation(internal.hubspotExports.release, { id: attempt._id })
		).rejects.toThrow('expired');
		await expect(
			other.client.mutation(api.hubspotExports.acknowledge, {
				membershipId: other.membershipId,
				id: attempt._id,
				initiatedAt: NOW
			})
		).rejects.toThrow('unavailable');
		expect(await f.t.run(({ db }) => db.get('savedContracts', f.id))).toEqual(before);
		expect(
			(await f.t.run(({ db }) => db.get('hubspotExports', attempt._id)))?.acknowledgedAt
		).toBeUndefined();
	});
	it('allows another member of the same company to repair the link but not retrieve the original member’s export', async () => {
		const f = await fixture(),
			attempt = await readyExport(f);
		await markUnavailable(f);
		await f.repClient.mutation(internal.hubspotDeals.commit, {
			...f.creation,
			membershipId: f.rep.membershipId,
			contractId: f.id,
			expectedGeneration: 1,
			dealId: '202',
			operationId: 'rep-repair'
		});
		expect(await f.t.run(({ db }) => db.get('savedContracts', f.id))).toMatchObject({
			hubspot: { dealId: '202', availability: 'available' }
		});
		await expect(
			f.repClient.mutation(internal.hubspotExports.release, { id: attempt._id })
		).rejects.toThrow('expired');
		await expect(
			f.repClient.mutation(api.hubspotExports.acknowledge, {
				membershipId: f.rep.membershipId,
				id: attempt._id,
				initiatedAt: NOW
			})
		).rejects.toThrow('unavailable');
	});
	it('returns installation status without exposing credentials', async () => {
		const f = await fixture();
		expect(
			await f.t.query(api.hubspotConnections.status, { membershipId: f.owner.membershipId })
		).toEqual({
			configured: true,
			enabled: true,
			status: 'connected',
			accountId: '12345',
			installedAt: NOW
		});
	});
});

describe('OAuth installation authority', () => {
	it('allows only admins to start installation', async () => {
		const f = await fixture();
		await expect(f.repClient.action(api.hubspotOAuth.start, {})).rejects.toThrow('Only admins');
		expect(await f.t.run(({ db }) => db.query('hubspotOAuthStates').collect())).toEqual([]);
		const start = await f.t.action(api.hubspotOAuth.start, {}),
			url = new URL(start.url);
		expect(url.searchParams.get('state')).toBe(start.state);
		expect(url.searchParams.get('redirect_uri')).toBe('https://dinu.example/api/hubspot/callback');
		const stored = await f.t.run(({ db }) => db.query('hubspotOAuthStates').unique());
		expect(stored?.hash).toBe(await sha256(start.state));
		expect(stored?.hash).not.toBe(start.state);
	});
	it('binds state to the initiating admin, expires it, and makes claiming single-use', async () => {
		const f = await fixture(),
			hash = await sha256('bound-state');
		await f.t.mutation(internal.hubspotOAuth.reserve, { hash });
		await f.t.run(({ db }) => db.patch('memberships', f.rep.membershipId, { role: 'admin' }));
		await expect(f.repClient.mutation(internal.hubspotOAuth.claim, { hash })).rejects.toThrow(
			'expired'
		);
		await f.t.mutation(internal.hubspotOAuth.claim, { hash });
		await expect(f.t.mutation(internal.hubspotOAuth.claim, { hash })).rejects.toThrow('expired');
		await f.t.mutation(internal.hubspotOAuth.reserve, { hash: 'expiring' });
		vi.setSystemTime(NOW + 10 * 60_000 + 1);
		await expect(f.t.mutation(internal.hubspotOAuth.claim, { hash: 'expiring' })).rejects.toThrow(
			'expired'
		);
	});
	it('commits a reconnect once, rejects competing installs, and preserves the original account', async () => {
		const f = await fixture(),
			first = await reservedState(f),
			competing = await reservedState(f, 'competing');
		await expect(
			f.t.mutation(internal.hubspotOAuth.commit, {
				stateId: first.id,
				accountId: 'other-account',
				scopes: [],
				tokens
			})
		).rejects.toThrow('original HubSpot account');
		await f.t.mutation(internal.hubspotOAuth.commit, {
			stateId: first.id,
			accountId: '12345',
			scopes: ['oauth'],
			tokens
		});
		await expect(
			f.t.mutation(internal.hubspotOAuth.commit, {
				stateId: first.id,
				accountId: '12345',
				scopes: ['oauth'],
				tokens
			})
		).rejects.toThrow('expired');
		await expect(
			f.t.mutation(internal.hubspotOAuth.commit, {
				stateId: competing.id,
				accountId: '12345',
				scopes: ['oauth'],
				tokens
			})
		).rejects.toThrow('finished first');
		expect(await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId))).toMatchObject({
			accountId: '12345',
			generation: 2,
			accessToken: tokens.accessToken
		});
	});
	it('rejects an installation missing scopes and prevents reuse of its authorization code', async () => {
		const f = await fixture(),
			state = 'missing-scopes';
		await f.t.mutation(internal.hubspotOAuth.reserve, { hash: await sha256(state) });
		const fetcher = vi.fn(async (input: string) =>
			input.endsWith('/token')
				? json({ access_token: 'synthetic', refresh_token: 'synthetic', expires_in: 3600 })
				: json({ hub_id: '12345', scopes: ['oauth'] })
		);
		vi.stubGlobal('fetch', fetcher);
		await expect(
			f.t.action(api.hubspotOAuth.finish, { state, code: 'synthetic-code' })
		).rejects.toThrow('missing required permissions');
		expect(fetcher).toHaveBeenCalledTimes(2);
		await expect(
			f.t.action(api.hubspotOAuth.finish, { state, code: 'synthetic-code' })
		).rejects.toThrow('expired');
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(
			(await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId)))?.generation
		).toBe(1);
	});
});

describe('deal picker', () => {
	it('requests twelve recent browse candidates and three search matches, including named closed deals and excluding archived records', async () => {
		const f = await fixture();
		const fetcher = vi.fn<typeof fetch>(async () =>
			json({
				results: [
					{ id: '1', properties: { dealname: 'Closed won', dealstage: 'closedwon' } },
					{ id: '2', archived: true, properties: { dealname: 'Archived' } },
					{ id: '3', properties: {} }
				],
				paging: { next: { after: '100' } }
			})
		);
		vi.stubGlobal('fetch', fetcher);
		for (const search of ['', 'Closed']) {
			const result = await f.t.action(api.hubspotDeals.list, {
				membershipId: f.owner.membershipId,
				search
			});
			expect(result.deals).toEqual([{ id: '1', name: 'Closed won' }]);
			expect(result.hasMore).toBe(true);
			expect(fetcher).toHaveBeenLastCalledWith(
				'https://api.hubapi.com/crm/v3/objects/deals/search',
				expect.objectContaining({ method: 'POST' })
			);
			const request = fetcher.mock.lastCall![1]!;
			expect(JSON.parse(request.body as string)).toEqual({
				...(search ? { query: search } : {}),
				properties: ['dealname'],
				sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
				limit: search ? 3 : 12
			});
		}
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
