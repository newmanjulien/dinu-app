import { fixtureOperationId } from '../../support/operation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as word from '../../../src/lib/server/document/export/word';
import {
	api,
	fixture,
	integrationClock,
	currentContract,
	events,
	application,
	decision,
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
	const contract = await currentContract(f);
	return {
		membershipId: f.owner.membershipId,
		id: f.id,
		operationId: fixtureOperationId(operationId),
		expectedStateRevision: contract.root.stateRevision
	};
}

describe('seller Word generation action and approval fences', () => {
	it('stores and commits a real Word document and reuses the exact export and bytes on retries', async () => {
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
		await f.t.mutation(api.contracts.save, application(f));
		const request = await args(f);
		const result = await f.t.action(api.wordExport.generate, request);
		const exports = await f.t.run(({ db }) => db.query('wordExports').collect());
		expect(exports).toHaveLength(1);
		const stored = exports[0];
		expect(stored.createdAt).toBe(NOW);
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
		expect(retry.filename).toBe(result.filename);
		expect(await f.t.run(({ db }) => db.query('wordExports').collect())).toHaveLength(1);
		expect((await events(f)).map((e) => e.kind)).toEqual(['created', 'applied', 'downloaded']);
	});

	it('blocks pending and declined required changes, then permits export after approval', async () => {
		const f = await fixture();
		await f.repClient.mutation(api.contracts.save, {
			...application(f),
			membershipId: f.rep.membershipId
		});
		await expect(f.t.action(api.wordExport.generate, await args(f, 'pending'))).rejects.toThrow(
			'pending concessions'
		);
		await f.t.mutation(api.approvals.decide, await decision(f, 'decline', 'decline'));
		await expect(f.t.action(api.wordExport.generate, await args(f, 'declined'))).rejects.toThrow(
			'pending concessions'
		);
		expect(await f.t.run(({ db }) => db.query('wordExports').collect())).toEqual([]);
		await f.t.mutation(api.approvals.decide, await decision(f, 'approve', 'approve'));
		await f.t.action(api.wordExport.generate, await args(f, 'approved'));
		expect(await f.t.run(({ db }) => db.query('wordExports').collect())).toHaveLength(1);
	});

	it('does not commit bytes if the contract changes while Word is being generated', async () => {
		const f = await fixture();
		const generate = word.generateWord;
		vi.spyOn(word, 'generateWord').mockImplementationOnce(async (...input) => {
			const blob = await generate(...input);
			await f.repClient.mutation(api.contracts.save, {
				...application(f, 'pending-mid-export'),
				membershipId: f.rep.membershipId
			});
			return blob;
		});
		await expect(f.t.action(api.wordExport.generate, await args(f))).rejects.toThrow(
			'The saved contract changed.'
		);
		expect(await f.t.run(({ db }) => db.query('wordExports').collect())).toEqual([]);
		expect((await events(f)).some((e) => e.kind === 'downloaded')).toBe(false);
	});
});
