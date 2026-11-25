import { fixtureOperationId } from '../../support/operation';
// @vitest-environment edge-runtime
import { describe, expect, it, vi } from 'vitest';
import {
	api,
	internal,
	fixture,
	exportDelivery,
	readyExport,
	currentContract,
	events,
	integrationClock,
	NOW,
	HOUR,
	send,
	json,
	bytes,
	application
} from '../../support/linked-contract';

integrationClock();

describe('Word export delivery and file lifetime', () => {
	it('records one HubSpot download delivery with a 30-day attachment hold and reuses committed exports on retry', async () => {
		const f = await fixture();
		const attempt = await readyExport(f, 'download');
		const first = {
			attempt: await f.t.run(({ db }) => db.get('wordExports', attempt._id)),
			delivery: await exportDelivery(f, attempt._id)
		};
		expect(first).toMatchObject({
			attempt: { createdAt: NOW },
			delivery: { attachmentUntil: NOW + 30 * 24 * HOUR }
		});
		expect((await events(f)).filter((e) => e.kind === 'downloaded')).toMatchObject([
			{ occurredAt: NOW, attemptId: attempt._id }
		]);
		vi.setSystemTime(NOW + 60_000);
		const contract = await currentContract(f);
		const retry = await f.t.mutation(internal.contractExports.commit, {
			membershipId: f.owner.membershipId,
			id: f.id,
			operationId: fixtureOperationId('download'),
			fileId: attempt.fileId!,
			sha256: attempt.sha256,
			size: attempt.size,
			expectedTemplateVersionId: contract.root.templateVersionId,
			expectedStateRevision: contract.root.stateRevision,
			expectedTitle: contract.root.title
		});
		expect(retry.filename).toBe(attempt.filename);
		expect((await events(f)).filter((e) => e.kind === 'downloaded')).toHaveLength(1);
	});

	it('adds no attachment hold or CRM activity for an unlinked download', async () => {
		const f = await fixture();
		await f.t.run(({ db }) => db.delete('hubspotConnections', f.connectionId));
		const created = await f.t.mutation(api.contracts.create, {
			membershipId: f.owner.membershipId,
			title: 'Manual',
			operationId: fixtureOperationId('manual')
		});
		if (created.status !== 'created') throw new Error('Manual creation failed');
		f.id = created.id;
		const attempt = await readyExport(f);
		expect(await exportDelivery(f, attempt._id)).toBeNull();
		expect(attempt.expiresAt).toBe(NOW + HOUR + 15 * 60_000);
		expect((await events(f)).map((e) => e.kind)).toEqual(['created']);
	});

	it('ends the attachment hold on File confirmation even when Note creation fails', async () => {
		const f = await fixture();
		const attempt = await readyExport(f);
		const download = (await events(f)).find((e) => e.attemptId === attempt._id)!;
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
		const stored = (await f.t.run(({ db }) => db.get('wordExports', attempt._id)))!;
		const delivery = await exportDelivery(f, attempt._id);
		expect(delivery?.remoteFileId).toBe('301');
		expect(delivery?.attachmentUntil).toBeUndefined();
		expect(stored.expiresAt).toBe(NOW + HOUR + 15 * 60_000);
		vi.setSystemTime(stored.expiresAt! - 1);
		await f.t.mutation(internal.contractExports.expire, {});
		expect(await f.t.run(async ({ storage }) => Boolean(await storage.get(attempt.fileId!)))).toBe(
			true
		);
		vi.setSystemTime(stored.expiresAt!);
		await f.t.mutation(internal.contractExports.expire, {});
		expect(await f.t.run(({ storage }) => storage.get(attempt.fileId!))).toBeNull();
		expect(await f.t.run(({ db }) => db.get('wordExports', attempt._id))).toMatchObject({
			sha256: attempt.sha256
		});
		expect((await f.t.run(({ db }) => db.get('wordExports', attempt._id)))?.fileId).toBeUndefined();
		expect((await exportDelivery(f, attempt._id))?.remoteFileId).toBe('301');
	});

	it('refuses commit if the saved contract changes between prepare and commit', async () => {
		const f = await fixture();
		const prepared = await f.t.query(internal.contractExports.prepare, {
			membershipId: f.owner.membershipId,
			id: f.id,
			operationId: fixtureOperationId('stale-commit'),
			expectedStateRevision: 0
		});
		if (prepared.kind !== 'generate') throw new Error('Expected generate');
		await f.t.mutation(api.contracts.save, application(f));
		const fileId = await f.t.run(({ storage }) => storage.store(new Blob([bytes])));
		await expect(
			f.t.mutation(internal.contractExports.commit, {
				membershipId: f.owner.membershipId,
				id: f.id,
				operationId: fixtureOperationId('stale-commit'),
				fileId,
				sha256: 'a'.repeat(64),
				size: bytes.byteLength,
				expectedTemplateVersionId: prepared.templateVersionId,
				expectedStateRevision: prepared.stateRevision,
				expectedTitle: prepared.title
			})
		).rejects.toThrow('The saved contract changed.');
	});
});

describe('private File reconciliation', () => {
	it('rejects a public file, wrong name, wrong size and wrong bytes while reaching a valid later candidate', async () => {
		const f = await fixture();
		const attempt = await readyExport(f);
		const download = (await events(f)).find((e) => e.attemptId === attempt._id)!;
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
