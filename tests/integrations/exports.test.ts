// @vitest-environment edge-runtime
import { describe, expect, it, vi } from 'vitest';
import {
	decodeProvenance,
	encodeProvenance,
	provenanceChunks
} from '../../src/convex/hubspotProvenance';
import type { AppliedConcessions } from '../../src/lib/contract/applications';
import type { Id } from '../../src/convex/_generated/dataModel';
import {
	api,
	internal,
	fixture,
	readyExport,
	acknowledge,
	events,
	integrationClock,
	NOW,
	HOUR,
	send,
	json,
	bytes,
	application
} from './fixtures';

integrationClock();

describe('download acknowledgments and file lifetime', () => {
	it('acknowledges a released download once, preserving original time and a fixed attachment hold', async () => {
		const f = await fixture(),
			attempt = await readyExport(f);
		vi.setSystemTime(NOW + 10_000);
		await acknowledge(f, attempt, NOW + 1000);
		const first = await f.t.run(({ db }) => db.get('hubspotExports', attempt._id));
		vi.setSystemTime(NOW + 60_000);
		await acknowledge(f, attempt, NOW + 60_000);
		expect(await f.t.run(({ db }) => db.get('hubspotExports', attempt._id))).toEqual(first);
		expect(first).toMatchObject({
			acknowledgedAt: NOW + 1000,
			acknowledgedOn: NOW + 10_000,
			attachmentUntil: NOW + 10_000 + 30 * 24 * HOUR
		});
		expect((await events(f)).filter((e) => e.kind === 'downloaded')).toMatchObject([
			{ occurredAt: NOW + 1000 }
		]);
	});
	it('does not extend the one-hour local retry window when release is repeated or a download is acknowledged', async () => {
		const f = await fixture(),
			attempt = await readyExport(f);
		vi.setSystemTime(NOW + HOUR - 1);
		await f.t.mutation(internal.hubspotExports.release, { id: attempt._id });
		await acknowledge(f, attempt);
		vi.setSystemTime(NOW + HOUR);
		await expect(
			f.t.mutation(internal.hubspotExports.release, { id: attempt._id })
		).rejects.toThrow('expired');
		expect((await f.t.run(({ db }) => db.get('hubspotExports', attempt._id)))?.releasedAt).toBe(
			NOW
		);
	});
	it('adds no attachment hold or CRM activity for an unlinked download', async () => {
		const f = await fixture();
		// Model a company without an installed integration, retaining the no-CRM guarantee.
		await f.t.run(({ db }) => db.delete('hubspotConnections', f.connectionId));
		const created = await f.t.mutation(api.contracts.create, {
			membershipId: f.owner.membershipId,
			buyerCompanyName: 'Manual',
			operationId: 'manual'
		});
		if (created.status !== 'created') throw new Error('Manual creation failed');
		f.id = created.id;
		const attempt = await readyExport(f);
		await acknowledge(f, attempt);
		const stored = await f.t.run(({ db }) => db.get('hubspotExports', attempt._id));
		expect(stored?.attachmentUntil).toBeUndefined();
		expect(stored?.expiresAt).toBe(NOW + HOUR + 15 * 60_000);
		expect((await events(f)).map((e) => e.kind)).toEqual(['created']);
	});
	it('ends the attachment hold on File confirmation even when Note creation fails', async () => {
		const f = await fixture(),
			attempt = await readyExport(f),
			download = await acknowledge(f, attempt);
		const fetcher = vi.fn(async (input: string) => {
			const p = new URL(input).pathname;
			if (p === '/files/v3/files') return json({ id: 'uploaded', access: 'PRIVATE' });
			if (p === '/crm/v3/objects/notes') throw new TypeError('Note response lost');
			return json({ id: '101', properties: { dealname: 'Original' } });
		});
		vi.stubGlobal('fetch', fetcher);
		await send(f, download._id);
		expect(await f.t.run(({ db }) => db.get('hubspotEvents', download._id))).toMatchObject({
			status: 'uncertain',
			dispatch: 'note',
			fileId: 'uploaded'
		});
		const stored = (await f.t.run(({ db }) => db.get('hubspotExports', attempt._id)))!;
		expect(stored.remoteFileId).toBe('uploaded');
		expect(stored.attachmentUntil).toBeUndefined();
		expect(stored.expiresAt).toBe(NOW + HOUR + 15 * 60_000);
		vi.setSystemTime(stored.expiresAt - 1);
		await f.t.mutation(internal.hubspotExports.expire, {});
		expect(await f.t.run(async ({ storage }) => Boolean(await storage.get(attempt.fileId!)))).toBe(
			true
		);
		vi.setSystemTime(stored.expiresAt);
		await f.t.mutation(internal.hubspotExports.expire, {});
		expect(await f.t.run(({ storage }) => storage.get(attempt.fileId!))).toBeNull();
		expect(await f.t.run(({ db }) => db.get('hubspotExports', attempt._id))).toMatchObject({
			state: 'expired',
			remoteFileId: 'uploaded',
			sha256: attempt.sha256
		});
		expect(await f.t.run(({ db }) => db.query('hubspotExportChunks').collect())).toHaveLength(1);
	});
	it('records a late acknowledgment truthfully after bytes expire without regenerating them', async () => {
		const f = await fixture(),
			attempt = await readyExport(f);
		vi.setSystemTime(NOW + HOUR + 15 * 60_000);
		await f.t.mutation(internal.hubspotExports.expire, {});
		const download = await acknowledge(f, attempt, NOW + 2000);
		expect(download).toMatchObject({ occurredAt: NOW + 2000, kind: 'downloaded' });
		expect(JSON.parse(download.detail).attachmentAvailable).toBe(false);
		const retained = (await f.t.run(({ db }) => db.get('hubspotExports', attempt._id)))!;
		expect(retained.fileId).toBeUndefined();
		expect(retained.attachmentUntil).toBeUndefined();
		expect(await f.t.run(({ storage }) => storage.get(attempt.fileId!))).toBeNull();
	});
	it('requires release first and rejects malformed, too-early and future acknowledgments without activity', async () => {
		const f = await fixture();
		const reserved = await f.t.mutation(internal.hubspotExports.reserve, {
			membershipId: f.owner.membershipId,
			id: f.id,
			expectedEditRevision: 0,
			operationId: 'unreleased',
			claim: 'claim'
		});
		await expect(acknowledge(f, reserved)).rejects.toThrow('unavailable');
		const attempt = await readyExport(f);
		await expect(
			f.t.mutation(api.hubspotExports.acknowledge, {
				membershipId: f.owner.membershipId,
				id: 'bad-id',
				initiatedAt: NOW
			})
		).rejects.toThrow('DOWNLOAD_ACK_TERMINAL');
		await expect(acknowledge(f, attempt, NOW - 60_001)).rejects.toThrow('DOWNLOAD_ACK_TERMINAL');
		await expect(acknowledge(f, attempt, NOW + 60_001)).rejects.toThrow('DOWNLOAD_ACK_FUTURE');
		expect((await events(f)).map((e) => e.kind)).toEqual(['created']);
	});
	it('prepares the reserved snapshot after the live contract changes', async () => {
		const f = await fixture();
		await f.t.mutation(api.contracts.saveChoices, application(f));
		const attempt = await f.t.mutation(internal.hubspotExports.reserve, {
			membershipId: f.owner.membershipId,
			id: f.id,
			expectedEditRevision: 1,
			operationId: 'frozen',
			claim: 'claim'
		});
		await f.t.mutation(api.contracts.saveChoices, {
			membershipId: f.owner.membershipId,
			id: f.id,
			choices: {},
			operationId: 'remove',
			expectedEditRevision: 1,
			commands: [{ id: 'remove', itemId: f.itemId, choice: null, occurredAt: NOW }]
		});
		const prepared = await f.t.query(internal.hubspotExports.content, {
			id: attempt._id,
			claim: 'claim'
		});
		expect(prepared.applications[f.itemId]).toMatchObject({
			concessionId: 'preferred',
			approval: { applicationId: 'application-1', status: 'approved' }
		});
		expect(prepared.items).toHaveLength(1);
		vi.setSystemTime(NOW + HOUR);
		await expect(
			f.t.query(internal.hubspotExports.content, { id: attempt._id, claim: 'claim' })
		).rejects.toThrow('unavailable');
	});
});

describe('private File reconciliation', () => {
	it('rejects a public file, wrong name, wrong size and wrong bytes while reaching a valid later candidate', async () => {
		const f = await fixture(),
			attempt = await readyExport(f),
			download = await acknowledge(f, attempt);
		await f.t.run(({ db }) =>
			db.patch('hubspotEvents', download._id, {
				status: 'uncertain',
				dispatch: 'file',
				dispatchId: 'file-intent',
				dispatchedAt: NOW
			})
		);
		const candidates = [
			'public',
			'wrong-name',
			'too-long',
			'wrong-hash',
			'another-hash',
			'correct'
		];
		let note: { properties: { hs_attachment_ids: string } } | undefined;
		const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(input),
				id = url.pathname.split('/').at(-1)!;
			if (url.pathname === '/files/v3/files/search')
				return json({ results: candidates.map((id) => ({ id })) });
			if (id === 'signed-url')
				return json({ url: `https://private.example/${url.pathname.split('/').at(-2)}` });
			if (url.hostname === 'private.example')
				return new Response(
					id === 'too-long'
						? new Uint8Array(bytes.length + 1)
						: ['wrong-hash', 'another-hash'].includes(id)
							? new Uint8Array(bytes.length)
							: bytes
				);
			if (url.pathname.startsWith('/files/v3/files/'))
				return json({
					id,
					name: id === 'wrong-name' ? 'another.docx' : `dinu-${download._id}.docx`,
					access: id === 'public' ? 'PUBLIC_INDEXABLE' : 'PRIVATE'
				});
			if (url.pathname === '/crm/v3/objects/notes') {
				note = JSON.parse(String(init?.body));
				return json({ id: 'note' });
			}
			return json({ id: '101', properties: { dealname: 'Original' } });
		});
		vi.stubGlobal('fetch', fetcher);
		const queued = await send(f, download._id);
		const first = (await f.t.run(({ db }) => db.get('hubspotEvents', download._id)))!;
		expect(first).toMatchObject({ status: 'uncertain', observation: { position: 5 } });
		expect(note).toBeUndefined();
		expect(fetcher.mock.calls.length).toBeLessThanOrEqual(12);
		await f.t.mutation(internal.hubspotDelivery.completed, {
			workId: queued.workId,
			context: { id: download._id, execution: queued.execution },
			result: { kind: 'success', returnValue: null }
		});
		vi.setSystemTime(NOW + 60_000);
		fetcher.mockClear();
		await send(f, download._id);
		expect(note).toMatchObject({ properties: { hs_attachment_ids: 'correct' } });
		expect(await f.t.run(({ db }) => db.get('hubspotEvents', download._id))).toMatchObject({
			status: 'sent',
			fileId: 'correct'
		});
		expect(
			fetcher.mock.calls.some(
				([, init]) => init?.method === 'POST' && init.body instanceof FormData
			)
		).toBe(false);
	});
});

describe('immutable export provenance', () => {
	it('round-trips order, identities, absent approval and all review statuses', () => {
		const applications: AppliedConcessions = Object.fromEntries([
			['z-last', { concessionId: 'none' }],
			...(['pending', 'approved', 'rejected'] as const).map((status) => [
				status,
				{ concessionId: `choice-${status}`, approval: { applicationId: `app-${status}`, status } }
			])
		]);
		const decoded = decodeProvenance(encodeProvenance(applications));
		expect(decoded).toEqual(applications);
		expect(Object.keys(decoded)).toEqual(Object.keys(applications));
	});
	it('chunks escaped Unicode by bytes without losing surrogate pairs or complete provenance', () => {
		const applications: AppliedConcessions = {
			['item' as Id<'playbookItems'>]: { concessionId: '😀"\\\n'.repeat(50_000) }
		};
		const encoded = encodeProvenance(applications),
			chunks = provenanceChunks(encoded);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(120 * 1024);
			expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
		}
		expect(decodeProvenance(chunks.join(''))).toEqual(applications);
	});
});
