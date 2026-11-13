import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as word from '../../../src/lib/server/document/export/word';
import {
	api,
	fixture,
	integrationClock,
	expectedSource,
	events,
	application,
	decision,
	playbookState,
	NOW
} from '../../support/linked-contract';
import { elements, readDocx, textContent } from './docx';
import { item } from '../../support/contract-data';

integrationClock();
beforeEach(() => {
	// JSZip uses setImmediate while packing; keep it real while freezing backend clocks/jobs.
	vi.useFakeTimers({
		toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
	});
	vi.setSystemTime(NOW);
});
async function args(f: Awaited<ReturnType<typeof fixture>>, operationId = 'real-word') {
	return {
		membershipId: f.owner.membershipId,
		id: f.id,
		expectedSource: await expectedSource(f),
		operationId,
		claim: 'real-word-claim'
	};
}

describe('seller Word generation action and approval fences', () => {
	it('stores and releases a real Word document and reuses the exact attempt and bytes on retries', async () => {
		const f = await fixture({
			items: [
				{
					...item,
					concessions: [
						{
							...item.concessions[0],
							changes: [
								{
									target: item.trigger.target,
									replacement: [{ kind: 'text', text: 'Negotiated & approved' }]
								}
							]
						}
					]
				}
			]
		});
		await f.t.mutation(api.contracts.saveChanges, application(f));
		const request = await args(f);
		const result = await f.t.action(api.wordExport.generate, request);
		const stored = (await f.t.run(({ db }) => db.get('hubspotExports', result.attemptId)))!;
		expect(stored).toMatchObject({ state: 'ready', releasedAt: NOW });
		expect(result.filename).toBe('Original deal & contract - Contract - 2026-11-07 12-00-00.docx');
		expect(result.url).toMatch(/^https?:\/\//u);
		const blob = new Blob([
			await f.t.run(async ({ storage }) => (await storage.get(stored.fileId!))!.arrayBuffer())
		]);
		const parts = await readDocx(blob);
		expect(elements(parts['word/document.xml'], 'w:t').map(textContent)).toEqual([
			'Negotiated & approved contract.'
		]);
		const bytes = new Uint8Array(await blob.arrayBuffer());
		expect(stored.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
		expect(stored.size).toBe(bytes.length);
		const retry = await f.t.action(api.wordExport.generate, request);
		expect(retry.attemptId).toBe(result.attemptId);
		expect(await f.t.run(({ db }) => db.query('hubspotExports').collect())).toHaveLength(1);
		expect(await f.t.run(({ db }) => db.get('hubspotExports', result.attemptId))).toEqual(stored);
		expect((await events(f)).map((e) => e.kind)).toEqual(['created', 'applied']); // Generation alone is not a download acknowledgment.
	});

	it('blocks pending and declined required changes, then permits export after approval', async () => {
		const f = await fixture();
		await f.repClient.mutation(api.contracts.saveChanges, {
			...application(f),
			membershipId: f.rep.membershipId
		});
		await expect(f.t.action(api.wordExport.generate, await args(f, 'pending'))).rejects.toThrow(
			'APPROVAL_REQUIRED'
		);
		await f.t.mutation(api.contractApprovals.decideChange, await decision(f, 'decline', 'decline'));
		await expect(f.t.action(api.wordExport.generate, await args(f, 'declined'))).rejects.toThrow(
			'APPROVAL_REQUIRED'
		);
		expect(await f.t.run(({ db }) => db.query('hubspotExports').collect())).toEqual([]);
		await f.t.mutation(api.contractApprovals.decideChange, await decision(f, 'approve', 'approve'));
		const output = await f.t.action(api.wordExport.generate, await args(f, 'approved'));
		expect(await f.t.run(({ db }) => db.get('hubspotExports', output.attemptId))).toMatchObject({
			state: 'ready',
			releasedAt: NOW
		});
	});

	it('does not release bytes if a required removal becomes pending while Word is being generated', async () => {
		const f = await fixture();
		await f.repClient.mutation(api.contracts.saveChanges, {
			...application(f),
			membershipId: f.rep.membershipId
		});
		await f.t.mutation(api.contractApprovals.decideChange, await decision(f, 'approve', 'approve'));
		const generate = word.generateWord;
		vi.spyOn(word, 'generateWord').mockImplementationOnce(async (...input) => {
			const blob = await generate(...input);
			await f.repClient.mutation(api.contracts.saveChanges, {
				membershipId: f.rep.membershipId,
				id: f.id,
				operationId: 'pending-removal',
				commands: [
					{
						...application(f).commands[0],
						id: 'remove',
						expectedCurrentChangeId: (await playbookState(f)).playbook[0].currentChangeId,
						action: { kind: 'set', optionId: null }
					}
				]
			});
			expect((await playbookState(f)).playbook[0].status).toBe('pending');
			return blob;
		});
		await expect(f.t.action(api.wordExport.generate, await args(f))).rejects.toThrow(
			/STALE_SOURCE|APPROVAL_REQUIRED/u
		);
		const outputs = await f.t.run(({ db }) => db.query('hubspotExports').collect());
		expect(outputs).toHaveLength(1);
		expect(outputs[0].releasedAt).toBeUndefined();
		expect((await events(f)).some((e) => e.kind === 'downloaded')).toBe(false);
	});
});
