// @vitest-environment edge-runtime
import { describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '@convex-dev/rate-limiter';
import { components } from '../../src/convex/_generated/api';
import {
	internal,
	fixture,
	event,
	enqueue,
	claim,
	send,
	complete,
	integrationClock,
	json,
	NOW,
	HOUR,
	readyExport,
	acknowledge,
	bytes,
	relink
} from './fixtures';

integrationClock();
const deal = () => json({ id: '101', properties: { dealname: 'Original deal' } });
const path = (input: string | URL | Request) => new URL(String(input)).pathname;
async function retry(
	f: Awaited<ReturnType<typeof fixture>>,
	queued: Awaited<ReturnType<typeof enqueue>>
) {
	await complete(f, queued);
	const row = (await f.t.run(({ db }) => db.get('hubspotEvents', queued._id)))!;
	vi.setSystemTime(Math.max(Date.now() + 60_000, row.dueAt));
	return send(f, row._id);
}

describe('ambiguous provider writes', () => {
	it('finds a Note created before a lost response without a second create', async () => {
		const f = await fixture();
		let remote: { id: string; properties: { hs_note_body: string } } | undefined;
		const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
			const p = path(input);
			if (p === '/crm/v3/objects/notes') {
				remote = { id: 'remote-note', properties: JSON.parse(String(init?.body)).properties };
				throw new TypeError('Response lost after provider committed');
			}
			if (p.includes('/associations/notes'))
				return json({ results: [{ toObjectId: 'remote-note' }] });
			if (p.endsWith('/notes/remote-note')) return json(remote);
			return deal();
		});
		vi.stubGlobal('fetch', fetcher);
		const queued = await send(f);
		const uncertain = await event(f);
		expect(uncertain).toMatchObject({ status: 'uncertain', dispatch: 'note' });
		expect(uncertain.dispatchId).toBeTruthy();
		await retry(f, queued);
		expect(await event(f)).toMatchObject({ status: 'sent', noteId: 'remote-note' });
		expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
	});
	it.each(['empty', 'missing', 'throttled'] as const)(
		'preserves uncertainty after %s observation, without resending',
		async (mode) => {
			const f = await fixture(),
				row = await event(f);
			await f.t.run(({ db }) =>
				db.patch('hubspotEvents', row._id, {
					status: 'uncertain',
					dispatch: 'note',
					dispatchId: 'original-note',
					dispatchedAt: NOW
				})
			);
			const fetcher = vi.fn(async (input: string, _init?: RequestInit) => {
				if (path(input).includes('/associations/notes'))
					return mode === 'throttled'
						? json({}, 429, { 'retry-after': '5' })
						: json({ results: mode === 'empty' ? [] : [{ toObjectId: 'missing-note' }] });
				return json({}, 404);
			});
			vi.stubGlobal('fetch', fetcher);
			await send(f);
			expect(await event(f)).toMatchObject({
				status: 'uncertain',
				dispatch: 'note',
				dispatchId: 'original-note',
				dispatchedAt: NOW
			});
			expect(
				fetcher.mock.calls.every(
					(call) => call.length === 1 || !(call[1] as RequestInit | undefined)?.method
				)
			).toBe(true);
		}
	);
	it('clears only a fresh definitely-unsent intent when local quota denies the create', async () => {
		const f = await fixture();
		const limiter = new RateLimiter(components.rateLimiter, {
			hubspot: { kind: 'token bucket', rate: 80, period: 10_000, capacity: 80 }
		});
		const fetcher = vi.fn(async () => {
			await f.t.run((ctx) => limiter.limit(ctx, 'hubspot', { key: '12345', count: 79 }));
			return deal();
		});
		vi.stubGlobal('fetch', fetcher);
		await send(f);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(await event(f)).toMatchObject({
			status: 'pending',
			diagnostic: 'HubSpot request deferred'
		});
		expect((await event(f)).dispatch).toBeUndefined();
	});
	it('reconciles an uploaded file by exact private metadata and bytes, then attaches it without reupload', async () => {
		const f = await fixture(),
			attempt = await readyExport(f),
			download = await acknowledge(f, attempt);
		let uploaded: File | null = null,
			options: unknown,
			postedNote: Record<string, unknown> | undefined;
		const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
			const p = path(input);
			if (p === '/files/v3/files') {
				const form = init!.body as FormData;
				uploaded = form.get('file') as File;
				options = JSON.parse(String(form.get('options')));
				throw new TypeError('File committed; response lost');
			}
			if (p === '/files/v3/files/search') return json({ results: [{ id: 'remote-file' }] });
			if (p.endsWith('/signed-url')) return json({ url: 'https://private.example/file' });
			if (p === '/file') return new Response(bytes);
			if (p === '/files/v3/files/remote-file')
				return json({ id: 'remote-file', name: `dinu-${download._id}.docx`, access: 'PRIVATE' });
			if (p === '/crm/v3/objects/notes') {
				postedNote = JSON.parse(String(init?.body));
				return json({ id: 'download-note' });
			}
			return deal();
		});
		vi.stubGlobal('fetch', fetcher);
		const queued = await send(f, download._id);
		expect(await f.t.run(({ db }) => db.get('hubspotEvents', download._id))).toMatchObject({
			status: 'uncertain',
			dispatch: 'file'
		});
		expect(options).toEqual({ access: 'PRIVATE', overwrite: false });
		expect(new Uint8Array(await uploaded!.arrayBuffer())).toEqual(bytes);
		await retry(f, queued);
		expect(await f.t.run(({ db }) => db.get('hubspotEvents', download._id))).toMatchObject({
			status: 'sent',
			fileId: 'remote-file',
			noteId: 'download-note'
		});
		expect(postedNote).toMatchObject({
			properties: { hs_attachment_ids: 'remote-file' },
			associations: [{ to: { id: '101' } }]
		});
		expect(fetcher.mock.calls.filter(([input]) => path(input) === '/files/v3/files')).toHaveLength(
			1
		);
		expect(await f.t.run(({ db }) => db.get('hubspotExports', attempt._id))).toMatchObject({
			remoteFileId: 'remote-file'
		});
	});
});

describe('execution and credential fences', () => {
	it('runs queued delivery and its completion through the real Workpool component', async () => {
		const f = await fixture();
		const fetcher = vi.fn(async (input: string) =>
			path(input) === '/crm/v3/objects/notes' ? json({ id: 'scheduled-note' }) : deal()
		);
		vi.stubGlobal('fetch', fetcher);
		await f.t.mutation(internal.hubspotDelivery.pump, {});
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await event(f)).toMatchObject({ status: 'sent', noteId: 'scheduled-note' });
		expect((await event(f)).workId).toBeUndefined();
		expect((await event(f)).execution).toBeUndefined();
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it('cannot install an unavailable-link block after its lease expires', async () => {
		const f = await fixture(),
			owned = await claim(f);
		vi.setSystemTime(NOW + 5 * 60_000);
		await f.t.mutation(internal.hubspotDelivery.settle, {
			id: owned._id,
			claim: owned.claim!,
			generation: 1,
			outcome: 'unavailable'
		});
		expect(await f.t.run(({ db }) => db.query('hubspotLinkBlocks').collect())).toEqual([]);
		expect(await f.t.run(({ db }) => db.get('savedContracts', f.id))).toMatchObject({
			hubspot: { availability: 'available' }
		});
	});
	it('ignores an old in-flight 401 after the connection has been reconnected', async () => {
		const f = await fixture();
		const fetcher = vi.fn(async () => {
			await f.t.run(({ db }) =>
				db.patch('hubspotConnections', f.connectionId, {
					generation: 2,
					accessToken: 'new-synthetic-access'
				})
			);
			return json({}, 401);
		});
		vi.stubGlobal('fetch', fetcher);
		await send(f);
		expect(await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId))).toMatchObject({
			generation: 2,
			status: 'connected'
		});
		expect(await event(f)).toMatchObject({ status: 'pending' });
		expect((await event(f)).dispatch).toBeUndefined();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it('rejects duplicate/stale claims and stale dispatches without changing the active owner', async () => {
		const f = await fixture(),
			owned = await claim(f);
		const before = await event(f);
		expect(
			await f.t.mutation(internal.hubspotDelivery.claim, {
				id: owned._id,
				execution: owned.execution,
				claim: 'duplicate'
			})
		).toBeNull();
		expect(
			await f.t.mutation(internal.hubspotDelivery.claim, {
				id: owned._id,
				execution: 'old-execution',
				claim: 'stale'
			})
		).toBeNull();
		expect(
			await f.t.mutation(internal.hubspotDelivery.dispatch, {
				id: owned._id,
				claim: 'stale',
				generation: 1,
				kind: 'note'
			})
		).toBeNull();
		expect(await event(f)).toEqual(before);
	});
	it('ignores a delayed completion and settlement after ownership changes', async () => {
		const f = await fixture(),
			owned = await claim(f);
		await f.t.run(({ db }) =>
			db.patch('hubspotEvents', owned._id, {
				execution: 'replacement',
				claim: 'replacement-claim',
				workId: 'replacement-work'
			})
		);
		const before = await event(f);
		await complete(f, owned);
		await f.t.mutation(internal.hubspotDelivery.settle, {
			id: owned._id,
			claim: owned.claim!,
			generation: 1,
			outcome: 'unavailable'
		});
		expect(await event(f)).toEqual(before);
		expect(await f.t.run(({ db }) => db.query('hubspotLinkBlocks').collect())).toEqual([]);
	});
	it('does not let stale credentials block a current deal or invalidate reconnected credentials', async () => {
		const f = await fixture(),
			owned = await claim(f);
		await f.t.run(({ db }) => db.patch('hubspotConnections', f.connectionId, { generation: 2 }));
		await f.t.mutation(internal.hubspotDelivery.settle, {
			id: owned._id,
			claim: owned.claim!,
			generation: 1,
			outcome: 'unavailable'
		});
		expect(
			await f.t.mutation(internal.hubspotConnections.reconnect, {
				id: f.connectionId,
				companyId: f.owner.companyId,
				accountId: '12345',
				generation: 1
			})
		).toBe(false);
		expect(await f.t.run(({ db }) => db.get('savedContracts', f.id))).toMatchObject({
			hubspot: { availability: 'available' }
		});
		expect(await f.t.run(({ db }) => db.get('hubspotConnections', f.connectionId))).toMatchObject({
			status: 'connected',
			generation: 2
		});
		expect(await f.t.run(({ db }) => db.query('hubspotLinkBlocks').collect())).toHaveLength(0);
	});
	it('settles positive historical Note evidence after relinking without touching the replacement', async () => {
		const f = await fixture(),
			owned = await claim(f);
		const dispatchId = await f.t.mutation(internal.hubspotDelivery.dispatch, {
			id: owned._id,
			claim: owned.claim!,
			generation: 1,
			kind: 'note'
		});
		await f.t.mutation(internal.hubspotDelivery.settle, {
			id: owned._id,
			claim: owned.claim!,
			generation: 1,
			outcome: 'unavailable'
		});
		await complete(f, owned);
		await relink(f);
		vi.setSystemTime(NOW + 60_000);
		const fetcher = vi.fn(async (input: string) =>
			path(input).includes('/associations/notes')
				? json({ results: [{ toObjectId: 'old-note' }] })
				: json({ id: 'old-note', properties: { hs_note_body: `Dinu activity ${owned._id}` } })
		);
		vi.stubGlobal('fetch', fetcher);
		await send(f);
		expect(dispatchId).toBeTruthy();
		expect(await event(f)).toMatchObject({
			status: 'sent',
			noteId: 'old-note',
			destination: { dealId: '101' }
		});
		expect(await f.t.run(({ db }) => db.get('savedContracts', f.id))).toMatchObject({
			hubspot: { dealId: '202', generation: 2, availability: 'available' }
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it('requires matching dispatch identity and a remote ID before accepting positive settlement', async () => {
		const f = await fixture(),
			owned = await claim(f);
		await f.t.mutation(internal.hubspotDelivery.dispatch, {
			id: owned._id,
			claim: owned.claim!,
			generation: 1,
			kind: 'note'
		});
		const before = await event(f);
		await f.t.mutation(internal.hubspotDelivery.settle, {
			id: owned._id,
			claim: owned.claim!,
			generation: 1,
			outcome: 'sent',
			dispatchId: 'wrong',
			remoteId: 'note'
		});
		await f.t.mutation(internal.hubspotDelivery.settle, {
			id: owned._id,
			claim: owned.claim!,
			generation: 1,
			outcome: 'sent',
			dispatchId: before.dispatchId
		});
		expect(await event(f)).toEqual(before);
	});
	it('retains an ambiguous write when a read fails and when definitely-unsent authority belongs to another dispatch', async () => {
		const f = await fixture(),
			owned = await claim(f);
		const dispatchId = await f.t.mutation(internal.hubspotDelivery.dispatch, {
			id: owned._id,
			claim: owned.claim!,
			generation: 1,
			kind: 'note'
		});
		await f.t.mutation(internal.hubspotDelivery.settle, {
			id: owned._id,
			claim: owned.claim!,
			generation: 1,
			outcome: 'retry',
			definitelyUnsent: true,
			dispatchId: 'different-dispatch'
		});
		expect(await event(f)).toMatchObject({ status: 'uncertain', dispatch: 'note', dispatchId });
	});
	it('does not reclaim a started execution before its lease and retirement grace end', async () => {
		const f = await fixture(),
			owned = await claim(f);
		vi.setSystemTime(NOW + 5 * 60_000 + 29_999);
		await f.t.mutation(internal.hubspotDelivery.pump, {});
		expect((await event(f)).execution).toBe(owned.execution);
		vi.setSystemTime(NOW + 5 * 60_000 + 30_001);
		await f.t.mutation(internal.hubspotDelivery.pump, {});
		expect((await event(f)).execution).not.toBe(owned.execution);
		expect((await event(f)).claim).toBeUndefined();
		expect(
			await f.t.mutation(internal.hubspotDelivery.dispatch, {
				id: owned._id,
				claim: owned.claim!,
				generation: 1,
				kind: 'note'
			})
		).toBeNull();
	});
});

describe('bounded resumable reconciliation', () => {
	it('yields with the attempted frontier intact when elapsed time leaves insufficient reserve', async () => {
		const f = await fixture(),
			row = await event(f);
		await f.t.run(({ db }) =>
			db.patch('hubspotEvents', row._id, {
				status: 'uncertain',
				dispatch: 'note',
				dispatchId: 'slow-note',
				dispatchedAt: NOW
			})
		);
		const fetcher = vi.fn(async (input: string) => {
			if (path(input).includes('/associations/notes'))
				return json({ results: [{ toObjectId: 'slow' }, { toObjectId: 'later' }] });
			vi.setSystemTime(NOW + 125_000);
			return json({}, 404);
		});
		vi.stubGlobal('fetch', fetcher);
		await send(f);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(await event(f)).toMatchObject({
			status: 'uncertain',
			dispatchedAt: NOW,
			observation: { position: 1, unresolved: 1 }
		});
	});
	it('advances past missing Notes across request-limited segments to find a late marker', async () => {
		const f = await fixture(),
			row = await event(f);
		await f.t.run(({ db }) =>
			db.patch('hubspotEvents', row._id, {
				status: 'uncertain',
				dispatch: 'note',
				dispatchId: 'note-intent',
				dispatchedAt: NOW
			})
		);
		const ids = Array.from({ length: 20 }, (_, i) => `note-${i}`);
		const fetcher = vi.fn(async (input: string) => {
			const p = path(input);
			if (p.includes('/associations/notes'))
				return json({ results: ids.map((toObjectId) => ({ toObjectId })) });
			return p.endsWith('/note-19')
				? json({ id: 'note-19', properties: { hs_note_body: `Dinu activity ${row._id}` } })
				: json({}, 404);
		});
		vi.stubGlobal('fetch', fetcher);
		const queued = await send(f);
		expect(fetcher).toHaveBeenCalledTimes(12);
		expect(await event(f)).toMatchObject({
			status: 'uncertain',
			observation: { position: 11, unresolved: 11 }
		});
		fetcher.mockClear();
		await retry(f, queued);
		expect(fetcher).toHaveBeenCalledTimes(9);
		expect(await event(f)).toMatchObject({ status: 'sent', noteId: 'note-19' });
		expect(fetcher.mock.calls.some(([input]) => path(input).includes('/associations/notes'))).toBe(
			false
		);
	});
	it('persists the next association page when the request budget ends', async () => {
		const f = await fixture(),
			row = await event(f);
		await f.t.run(({ db }) =>
			db.patch('hubspotEvents', row._id, {
				status: 'uncertain',
				dispatch: 'note',
				dispatchId: 'paged-note',
				dispatchedAt: NOW
			})
		);
		const fetcher = vi.fn(async (input: string) => {
			const url = new URL(input);
			if (url.pathname.includes('/associations/notes'))
				return url.searchParams.has('after')
					? json({ results: [{ toObjectId: 'last' }] })
					: json({
							results: Array.from({ length: 11 }, (_, i) => ({ toObjectId: `first-${i}` })),
							paging: { next: { after: 'page-two' } }
						});
			return url.pathname.endsWith('/last')
				? json({ id: 'last', properties: { hs_note_body: `Dinu activity ${row._id}` } })
				: json({
						id: url.pathname.split('/').at(-1),
						properties: { hs_note_body: 'Other activity' }
					});
		});
		vi.stubGlobal('fetch', fetcher);
		const queued = await send(f);
		expect((await event(f)).observation).toMatchObject({ page: 1, after: 'page-two', ids: [] });
		fetcher.mockClear();
		await retry(f, queued);
		expect(fetcher.mock.calls[0][0]).toContain('after=page-two');
		expect(await event(f)).toMatchObject({ status: 'sent', noteId: 'last' });
	});
	it('keeps the current member on global throttling and retries that member later', async () => {
		const f = await fixture(),
			row = await event(f);
		await f.t.run(({ db }) =>
			db.patch('hubspotEvents', row._id, {
				status: 'uncertain',
				dispatch: 'note',
				dispatchId: 'throttled',
				dispatchedAt: NOW
			})
		);
		let throttled = true;
		const fetcher = vi.fn(async (input: string) =>
			path(input).includes('/associations/notes')
				? json({ results: [{ toObjectId: 'member' }] })
				: throttled
					? json({}, 429)
					: json({ id: 'member', properties: { hs_note_body: `Dinu activity ${row._id}` } })
		);
		vi.stubGlobal('fetch', fetcher);
		const queued = await send(f);
		expect((await event(f)).observation).toMatchObject({ position: 0, unresolved: 0 });
		throttled = false;
		fetcher.mockClear();
		await retry(f, queued);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(await event(f)).toMatchObject({ status: 'sent', noteId: 'member' });
	});
	it('stops automatic observation at the original horizon and grants only one bounded operator segment', async () => {
		const f = await fixture(),
			row = await event(f);
		await f.t.run(({ db }) =>
			db.patch('hubspotEvents', row._id, {
				status: 'uncertain',
				dispatch: 'note',
				dispatchId: 'old-intent',
				dispatchedAt: NOW - 24 * HOUR
			})
		);
		const fetcher = vi.fn(async () => json({ results: [] }));
		vi.stubGlobal('fetch', fetcher);
		await f.t.mutation(internal.hubspotDelivery.pump, {});
		expect(await event(f)).toMatchObject({ status: 'attention', dispatchedAt: NOW - 24 * HOUR });
		expect(fetcher).not.toHaveBeenCalled();
		await f.t.mutation(internal.hubspotOperations.recover, {
			id: row._id,
			disposition: 'reconcile',
			evidence: 'support-ticket-123'
		});
		await send(f);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(await event(f)).toMatchObject({
			status: 'attention',
			dispatchedAt: NOW - 24 * HOUR,
			dispatchId: 'old-intent'
		});
		expect((await event(f)).operatorObservation).toBeUndefined();
	});
});
