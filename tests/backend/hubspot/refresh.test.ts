// @vitest-environment edge-runtime
import { describe, expect, it, vi } from 'vitest';
import { api, fixture, integrationClock, json, NOW } from '../../support/linked-contract';

integrationClock();
async function expired() {
	const f = await fixture();
	await f.t.run(({ db }) => db.patch('hubspotConnections', f.connectionId, { expiresAt: NOW }));
	return f;
}
const replacement = {
	access_token: 'rotated-access',
	refresh_token: 'rotated-refresh',
	expires_in: 3600
};
const list = (f: Awaited<ReturnType<typeof fixture>>) =>
	f.t.action(api.hubspotDeals.list, { membershipId: f.owner.membershipId, search: '' });

describe('expired HubSpot credentials', () => {
	it('exchanges the refresh token once and uses and persists the new credentials for subsequent requests', async () => {
		const f = await expired();
		const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
			if (new URL(input).pathname === '/oauth/v1/token') {
				expect(init?.body).toBeInstanceOf(URLSearchParams);
				expect((init!.body as URLSearchParams).get('grant_type')).toBe('refresh_token');
				expect((init!.body as URLSearchParams).get('refresh_token')).toBe('synthetic-refresh');
				return json(replacement);
			}
			expect(init?.headers).toMatchObject({ Authorization: 'Bearer rotated-access' });
			return json({ results: [{ id: '101', properties: { dealname: 'Original' } }] });
		});
		vi.stubGlobal('fetch', fetcher);
		expect((await list(f)).deals).toEqual([{ id: '101', name: 'Original' }]);
		await list(f);
		expect(fetcher.mock.calls.filter(([input]) => input.endsWith('/oauth/v1/token'))).toHaveLength(
			1
		);
		const row = await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId));
		expect(row).toMatchObject({
			status: 'connected',
			generation: 2,
			accessToken: 'rotated-access',
			refreshToken: 'rotated-refresh',
			expiresAt: NOW + 3_600_000
		});
		expect(row?.refreshClaim).toBeUndefined();
	});

	it('allows one refresh owner while a concurrent caller defers without a second exchange', async () => {
		const f = await expired();
		let release!: (value: Response) => void, entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const response = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const refresh = vi.fn(() => {
			entered();
			return response;
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string) =>
				input.endsWith('/oauth/v1/token') ? refresh() : json({ results: [] })
			)
		);
		const first = list(f);
		await started;
		await expect(list(f)).rejects.toThrow('429');
		expect(refresh).toHaveBeenCalledTimes(1);
		release(json(replacement));
		await first;
		await list(f);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('recovers a temporary refresh failure after the lease expires without disconnecting the account', async () => {
		const f = await expired();
		const refresh = vi
			.fn()
			.mockResolvedValueOnce(json({}, 503))
			.mockResolvedValue(json(replacement));
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string) =>
				input.endsWith('/oauth/v1/token') ? refresh() : json({ results: [] })
			)
		);
		await expect(list(f)).rejects.toThrow('503');
		expect(await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId))).toMatchObject({
			status: 'connected',
			generation: 1
		});
		await expect(list(f)).rejects.toThrow('429');
		vi.setSystemTime(NOW + 60_001);
		await list(f);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId))).toMatchObject({
			status: 'connected',
			generation: 2
		});
	});

	it.each([400, 401])(
		'requires reconnection after refresh is rejected with %i and never uses old credentials',
		async (status) => {
			const f = await expired();
			const fetcher = vi.fn(async () => json({}, status));
			vi.stubGlobal('fetch', fetcher);
			await expect(list(f)).rejects.toThrow(String(status));
			expect(await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId))).toMatchObject(
				{ status: 'reconnect', generation: 2 }
			);
			await expect(list(f)).rejects.toThrow('not connected');
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
	);
});
