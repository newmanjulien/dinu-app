import { fixtureOperationId } from '../../support/operation';
// @vitest-environment edge-runtime
import { describe, expect, it, vi } from 'vitest';
import { block } from '../../support/contract-data';
import {
	api,
	internal,
	fixture,
	exportDelivery,
	readyExport,
	reserveExport,
	prepareRelease,
	expectedSource,
	acknowledge,
	events,
	integrationClock,
	NOW,
	HOUR,
	send,
	json,
	bytes,
	application,
	playbookState
} from '../../support/linked-contract';

integrationClock();

describe('download acknowledgments and file lifetime', () => {
	it('preserves the original acknowledgment and attachment hold without extending the local retry window', async () => {
		const f = await fixture(),
			attempt = await readyExport(f);
		vi.setSystemTime(NOW + 10_000);
		await acknowledge(f, attempt, NOW + 1000);
		const first = {
			attempt: await f.t.run(({ db }) => db.get('hubspotExports', attempt._id)),
			delivery: await exportDelivery(f, attempt._id)
		};
		vi.setSystemTime(NOW + 60_000);
		await acknowledge(f, attempt, NOW + 60_000);
		expect({
			attempt: await f.t.run(({ db }) => db.get('hubspotExports', attempt._id)),
			delivery: await exportDelivery(f, attempt._id)
		}).toEqual(first);
		expect(first).toMatchObject({
			attempt: { acknowledgedAt: NOW + 1000, acknowledgedOn: NOW + 10_000 },
			delivery: { attachmentUntil: NOW + 10_000 + 30 * 24 * HOUR }
		});
		expect((await events(f)).filter((e) => e.kind === 'downloaded')).toMatchObject([
			{ occurredAt: NOW + 1000 }
		]);
		vi.setSystemTime(NOW + HOUR - 1);
		await prepareRelease(f, attempt._id);
		await f.t.mutation(internal.hubspotExports.release, { id: attempt._id });
		await acknowledge(f, attempt);
		expect({
			attempt: await f.t.run(({ db }) => db.get('hubspotExports', attempt._id)),
			delivery: await exportDelivery(f, attempt._id)
		}).toEqual(first);
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
			title: 'Manual',
			operationId: fixtureOperationId('manual')
		});
		if (created.status !== 'created') throw new Error('Manual creation failed');
		f.id = created.id;
		const attempt = await readyExport(f);
		await acknowledge(f, attempt);
		const stored = await f.t.run(({ db }) => db.get('hubspotExports', attempt._id));
		if (stored?.format !== 'full') throw new Error('Expected full output evidence');
		expect((await exportDelivery(f, attempt._id))?.attachmentUntil).toBeUndefined();
		expect(stored?.expiresAt).toBe(NOW + HOUR + 15 * 60_000);
		expect((await events(f)).map((e) => e.kind)).toEqual(['created']);
	});
	it('ends the attachment hold on File confirmation even when Note creation fails', async () => {
		const f = await fixture(),
			attempt = await readyExport(f),
			download = await acknowledge(f, attempt);
		const fetcher = vi.fn(async (input: string) => {
			const p = new URL(input).pathname;
			if (p === '/files/v3/files') return json({ id: '301', access: 'PRIVATE' });
			if (p === '/crm/v3/objects/notes') throw new TypeError('Note response lost');
			return json({ id: '101', properties: { dealname: 'Original' } });
		});
		vi.stubGlobal('fetch', fetcher);
		await send(f, download._id);
		expect(await f.t.run(({ db }) => db.get('hubspotEvents', download._id))).toMatchObject({
			status: 'uncertain',
			dispatch: 'note',
			fileId: '301'
		});
		const stored = (await f.t.run(({ db }) => db.get('hubspotExports', attempt._id)))!;
		if (stored?.format !== 'full') throw new Error('Expected full output evidence');
		const delivery = await exportDelivery(f, attempt._id);
		expect(delivery?.remoteFileId).toBe('301');
		expect(delivery?.attachmentUntil).toBeUndefined();
		expect(stored.expiresAt).toBe(NOW + HOUR + 15 * 60_000);
		vi.setSystemTime(stored.expiresAt - 1);
		await f.t.mutation(internal.hubspotExports.expire, { state: 'ready' });
		expect(await f.t.run(async ({ storage }) => Boolean(await storage.get(attempt.fileId!)))).toBe(
			true
		);
		vi.setSystemTime(stored.expiresAt);
		await f.t.mutation(internal.hubspotExports.expire, { state: 'ready' });
		expect(await f.t.run(({ storage }) => storage.get(attempt.fileId!))).toBeNull();
		expect(await f.t.run(({ db }) => db.get('hubspotExports', attempt._id))).toMatchObject({
			state: 'expired',
			sha256: attempt.sha256
		});
		expect((await exportDelivery(f, attempt._id))?.remoteFileId).toBe('301');
		expect(stored.outputId).toBe(attempt.outputId);
		expect(await f.t.run(({ db }) => db.get('contractOutputs', stored.outputId))).toMatchObject({
			state: 'complete',
			documentId: attempt.documentId,
			reservationManifest: {
				title: f.creation.name,
				documentId: attempt.documentId,
				proof: { outputId: attempt.outputId, section: 'output-proof' }
			}
		});
	});
	it('records a late acknowledgment truthfully after bytes expire without regenerating them', async () => {
		const f = await fixture(),
			attempt = await readyExport(f);
		vi.setSystemTime(NOW + HOUR + 15 * 60_000);
		await f.t.mutation(internal.hubspotExports.expire, { state: 'ready' });
		const download = await acknowledge(f, attempt, NOW + 2000);
		expect(download).toMatchObject({ occurredAt: NOW + 2000, kind: 'downloaded' });
		expect(JSON.parse(download.detail).attachmentAvailable).toBe(false);
		const retained = (await f.t.run(({ db }) => db.get('hubspotExports', attempt._id)))!;
		if (retained?.format !== 'full') throw new Error('Expected full output evidence');
		expect(retained.fileId).toBeUndefined();
		expect((await exportDelivery(f, attempt._id))?.attachmentUntil).toBeUndefined();
		expect(await f.t.run(({ storage }) => storage.get(attempt.fileId!))).toBeNull();
	});
	it('requires release first and rejects malformed, too-early and future acknowledgments without activity', async () => {
		const f = await fixture();
		const reserved = await reserveExport(f, {
			membershipId: f.owner.membershipId,
			id: f.id,
			expectedSource: await expectedSource(f),
			operationId: fixtureOperationId('unreleased'),
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
	it('prepares immutable reserved content after working edits but refuses a stale new release', async () => {
		const f = await fixture();
		await f.t.mutation(api.contracts.saveChanges, application(f));
		const released = await readyExport(f, 'already-released');
		const attempt = await reserveExport(f, {
			membershipId: f.owner.membershipId,
			id: f.id,
			expectedSource: await expectedSource(f),
			operationId: fixtureOperationId('frozen'),
			claim: 'claim'
		});
		const state = await playbookState(f);
		await f.t.mutation(api.contracts.saveChanges, {
			membershipId: f.owner.membershipId,
			id: f.id,
			operationId: fixtureOperationId('remove'),
			commands: [
				{
					id: fixtureOperationId('remove'),
					itemId: f.itemId,
					expectedCurrentChangeId: state.playbook[0].currentChangeId,
					action: { kind: 'set', optionId: null },
					occurredAt: NOW
				}
			]
		});
		const prepared = await f.t.query(internal.hubspotExports.content, {
			id: attempt._id,
			claim: 'claim'
		});
		const owner = await f.t.run(({ db }) => db.get('contractOutputs', attempt.outputId));
		if (owner?.format !== 'full') throw new Error('Expected full output evidence');
		expect(owner).toMatchObject({
			state: 'complete',
			companyId: f.owner.companyId,
			contractId: f.id,
			documentId: attempt.documentId,
			reservationManifest: {
				documentId: attempt.documentId,
				membershipId: f.owner.membershipId,
				actor: { profileId: f.owner.profileId },
				proof: { outputId: attempt.outputId, section: 'output-proof' }
			}
		});
		const proof = await f.t.run(({ db }) =>
			db
				.query('contractOutputChunks')
				.withIndex('by_outputId_and_section_and_generation_and_order', (q) =>
					q
						.eq('outputId', attempt.outputId)
						.eq('section', 'output-proof')
						.eq('generation', owner!.reservationManifest!.proof.generation)
				)
				.collect()
		);
		expect(proof.map((chunk) => JSON.parse(chunk.data))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'head',
					kind: 'playbook',
					key: f.itemId,
					changeId: state.playbook[0].currentChangeId,
					decisionId: state.playbook[0].decisionId
				})
			])
		);
		const evidence = proof
			.map((chunk) => JSON.parse(chunk.data))
			.filter((record) => record.kind === 'change')
			.map((record) => JSON.parse(record.data));
		expect(evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'playbook',
					source: expect.objectContaining({ itemId: f.itemId, optionId: 'preferred' })
				})
			])
		);
		expect(prepared.document.blocks).toEqual([block]);
		const fileId = await f.t.run(({ storage }) => storage.store(new Blob([bytes])));
		await f.t.mutation(internal.hubspotExports.publish, {
			id: attempt._id,
			claim: 'claim',
			fileId,
			sha256: released.sha256!,
			size: bytes.byteLength
		});
		await expect(
			prepareRelease(f, attempt._id).then(() =>
				f.t.mutation(internal.hubspotExports.release, { id: attempt._id })
			)
		).rejects.toThrow('STALE_SOURCE');
		const late = await acknowledge(f, released, NOW + 1000);
		expect(late).toMatchObject({ kind: 'downloaded', occurredAt: NOW + 1000 });
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
		const candidates = {
			public: '401',
			wrongName: '402',
			tooLong: '403',
			wrongHash: '404',
			anotherHash: '405',
			correct: '406'
		};
		let note: { properties: { hs_attachment_ids: string } } | undefined;
		const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(input),
				id = url.pathname.split('/').at(-1)!;
			if (url.pathname === '/files/v3/files/search')
				return json({ results: Object.values(candidates).map((id) => ({ id })) });
			if (id === 'signed-url')
				return json({ url: `https://private.example/${url.pathname.split('/').at(-2)}` });
			if (url.hostname === 'private.example')
				return new Response(
					id === candidates.tooLong
						? new Uint8Array(bytes.length + 1)
						: [candidates.wrongHash, candidates.anotherHash].includes(id)
							? new Uint8Array(bytes.length)
							: bytes
				);
			if (url.pathname.startsWith('/files/v3/files/'))
				return json({
					id,
					name: id === candidates.wrongName ? 'another.docx' : `dinu-${download._id}.docx`,
					access: id === candidates.public ? 'PUBLIC_INDEXABLE' : 'PRIVATE'
				});
			if (url.pathname === '/crm/v3/objects/notes') {
				note = JSON.parse(String(init?.body));
				return json({ id: '201' });
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
		expect(note).toMatchObject({ properties: { hs_attachment_ids: candidates.correct } });
		expect(await f.t.run(({ db }) => db.get('hubspotEvents', download._id))).toMatchObject({
			status: 'sent',
			fileId: candidates.correct
		});
		expect(
			fetcher.mock.calls.some(
				([, init]) => init?.method === 'POST' && init.body instanceof FormData
			)
		).toBe(false);
	});
});
