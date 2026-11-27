import { patchTestConnection } from '../../support/hubspot-credentials';
import { fixtureOperationId } from '../../support/operation';
// @vitest-environment edge-runtime
import { describe, expect, it, vi } from 'vitest';
import {
	api,
	internal,
	fixture,
	integrationClock,
	json,
	NOW,
	application,
	decision,
	playbookState
} from '../../support/linked-contract';
import { installQuotes, pushQuote, quoteArgs, sendQuote } from './quote-fixtures';
import { block } from '../../support/contract-data';

integrationClock();

describe('HubSpot Quotes workflow', () => {
	it('pushes exact saved terms to the linked deal once and verifies a later read without another POST', async () => {
		const f = await fixture();
		await installQuotes(f);
		const push = await pushQuote(f);
		expect(await pushQuote(f)).toEqual(push);
		expect((await pushQuote(f, 'second-click')).id).toBe(push.id);
		const bodies: { properties: Record<string, string>; associations: unknown[] }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string, init?: RequestInit) => {
				const path = new URL(input).pathname;
				if (path.includes('/deals/'))
					return json({ id: '101', properties: { dealname: 'Original' } });
				if (init?.method === 'POST') {
					bodies.push(JSON.parse(init.body as string));
					return json({ id: '901' });
				}
				return json({
					id: '901',
					properties: { hs_template_type: 'CPQ_QUOTE', hs_terms: bodies[0].properties.hs_terms },
					associations: { deals: { results: [{ id: '101' }] } }
				});
			})
		);
		expect(await sendQuote(f, push.id)).toMatchObject({ state: 'verifying', quoteId: '901' });
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			properties: {
				hs_template_type: 'CPQ_QUOTE',
				hs_terms: '<p>Synthetic contract.</p>',
				hs_payment_enabled: 'false',
				hs_billing_enabled: 'false'
			},
			associations: [
				{
					to: { id: '101' },
					types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 64 }]
				}
			]
		});
		vi.setSystemTime(NOW + 3000);
		expect(await sendQuote(f, push.id)).toMatchObject({
			state: 'verified',
			url: 'https://app.hubspot.com/quotes/12345/details/901'
		});
		expect(bodies).toHaveLength(1);
		expect(await f.t.run(({ db }) => db.query('hubspotQuotePushes').collect())).toHaveLength(1);
	});

	it('blocks another create after a lost provider response, including a new click and pump retries', async () => {
		const f = await fixture();
		await installQuotes(f);
		const push = await pushQuote(f);
		const create = vi.fn(async () => {
			throw new TypeError('Response lost after creation');
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_input: string, init?: RequestInit) =>
				init?.method === 'POST'
					? create()
					: json({ id: '101', properties: { dealname: 'Original' } })
			)
		);
		expect(await sendQuote(f, push.id)).toMatchObject({ state: 'unknown' });
		expect((await pushQuote(f, 'retry-click')).id).toBe(push.id);
		vi.setSystemTime(NOW + 10 * 60_000);
		await f.t.mutation(internal.hubspotQuotes.pump, {});
		expect(create).toHaveBeenCalledTimes(1);
		expect(await f.t.run(({ db }) => db.query('hubspotQuotePushes').collect())).toHaveLength(1);
	});

	it.each(['changed terms', 'wrong deal', 'archived', 'wrong type'])(
		'does not verify a quote with %s',
		async (fault) => {
			const f = await fixture();
			await installQuotes(f);
			const push = await pushQuote(f);
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: string, init?: RequestInit) => {
					if (new URL(input).pathname.includes('/deals/'))
						return json({ id: '101', properties: { dealname: 'Original' } });
					if (init?.method === 'POST') return json({ id: '901' });
					return json({
						id: '901',
						archived: fault === 'archived',
						properties: {
							hs_template_type: fault === 'wrong type' ? 'LEGACY' : 'CPQ_QUOTE',
							hs_terms:
								fault === 'changed terms'
									? '<p>Different obligation.</p>'
									: '<p>Synthetic contract.</p>'
						},
						associations: { deals: { results: [{ id: fault === 'wrong deal' ? '202' : '101' }] } }
					});
				})
			);
			await sendQuote(f, push.id);
			vi.setSystemTime(NOW + 3000);
			expect(await sendQuote(f, push.id)).toMatchObject({ state: 'attention', quoteId: '901' });
		}
	);

	it('requires approval before admission and retires a queued push if the saved contract changes before dispatch', async () => {
		const f = await fixture();
		await installQuotes(f);
		await f.repClient.mutation(api.contracts.save, {
			...application(f),
			membershipId: f.rep.membershipId
		});
		await expect(pushQuote(f)).rejects.toThrow('pending concessions');
		await f.t.mutation(api.approvals.decide, await decision(f, 'decline', 'decline'));
		await expect(pushQuote(f, 'declined')).rejects.toThrow('pending concessions');
		expect(await f.t.run(({ db }) => db.query('hubspotQuotePushes').collect())).toEqual([]);
		await f.t.mutation(api.approvals.decide, await decision(f, 'approve', 'approve'));
		const push = await pushQuote(f, 'approved-push');
		const current = await playbookState(f);
		await f.repClient.mutation(api.contracts.save, {
			membershipId: f.rep.membershipId,
			id: f.id,
			selections: {},
			expectedStateRevision: current.stateRevision,
			operationId: fixtureOperationId('removed-after-queue')
		});
		await f.t.mutation(internal.hubspotQuotes.pump, {});
		expect(await f.t.run(({ db }) => db.get('hubspotQuotePushes', push.id))).toMatchObject({
			state: 'retired'
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it('rejects missing Quotes scopes and stale deal destinations before reserving or contacting HubSpot', async () => {
		const f = await fixture();
		await installQuotes(f);
		const args = await quoteArgs(f);
		await expect(
			f.t.action(api.hubspotQuoteActions.push, {
				...args,
				destination: { ...args.destination, dealId: '202' }
			})
		).rejects.toThrow('deal changed');
		await f.t.run(({ db }) => patchTestConnection(db, f.connectionId, { scopes: ['oauth'] }));
		await expect(pushQuote(f)).rejects.toThrow('reconnect HubSpot Quotes');
		expect(await f.t.run(({ db }) => db.query('hubspotQuotePushes').collect())).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		['formatted Terms above the provider limit', '&'.repeat(14_000), '65,536-character'],
		['unsupported control characters', 'Synthetic\u0001 contract.', 'cannot render']
	])(
		'rejects %s without committing a push or making a provider request',
		async (_name, text, error) => {
			if (block.kind !== 'paragraph') throw new Error('Expected paragraph fixture');
			const f = await fixture({
				blocks: [{ ...block, content: [{ kind: 'text', sourceKey: 'text-1', text }] }]
			});
			await installQuotes(f);
			await expect(pushQuote(f)).rejects.toThrow(error);
			expect(await f.t.run(({ db }) => db.query('hubspotQuotePushes').collect())).toEqual([]);
			expect(fetch).not.toHaveBeenCalled();
		}
	);

	it('refuses commit if the saved contract changes between prepare and commit', async () => {
		const f = await fixture();
		await installQuotes(f);
		const args = await quoteArgs(f);
		const prepared = await f.t.query(internal.hubspotQuotes.prepare, args);
		if (prepared.kind !== 'generate') throw new Error('Expected generate preparation');
		await f.t.mutation(api.contracts.save, application(f));
		await expect(
			f.t.mutation(internal.hubspotQuotes.commit, {
				...args,
				canonicalKey: 'c'.repeat(64),
				fingerprint: 'a'.repeat(64),
				payloadHash: 'b'.repeat(64),
				preparedTemplateVersionId: prepared.templateVersionId,
				expectedTitle: prepared.title
			})
		).rejects.toThrow('The saved contract changed.');
		expect(await f.t.run(({ db }) => db.query('hubspotQuotePushes').collect())).toEqual([]);
	});
});
