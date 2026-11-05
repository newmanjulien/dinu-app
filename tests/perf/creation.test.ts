// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from '../../src/convex/_generated/api';
import schema from '../../src/convex/schema';
import { publishTemplate, readLiveSnapshot } from '../../src/convex/templates';
import { storeItemRevision } from '../../src/convex/playbookItemRevisions';
import { create } from '../../src/convex/savedContracts';
import { contractNotification } from '../../src/convex/emailNotifications';
import { normalizePlaybookItem } from '../../src/lib/playbook/model';
import type { MutationCtx } from '../../src/convex/_generated/server';
import type { Id } from '../../src/convex/_generated/dataModel';
import { block, item as baseItem, identity, initializeViewer } from './fixtures';
const item = {
	...baseItem,
	trigger: {
		id: 'trigger',
		range: { start: { sourceKey: 'text-1', offset: 0 }, end: { sourceKey: 'text-1', offset: 9 } }
	}
};

const modules = import.meta.glob('../../src/convex/**/*.*s');
async function emptyFixture() {
	const t = convexTest(schema, modules).withIdentity(identity);
	const { profileId, companyId, membershipId } = await t.run(initializeViewer);
	return { t, profileId, companyId, membershipId };
}
async function finishTemplate(
	t: Awaited<ReturnType<typeof emptyFixture>>['t'],
	companyId: Id<'company'>
) {
	return (
		await t.mutation(internal.operator.bootstrap, {
			companyId,
			blocks: [block],
			items: [{ ...item, instructions: { changesNeedApproval: 'Ask first.' } }]
		})
	).versionId;
}
async function fixture() {
	const state = await emptyFixture();
	await finishTemplate(state.t, state.companyId);
	const itemId = await state.t.run(
		async ({ db }) =>
			(await db
				.query('playbookItems')
				.withIndex('by_companyId', (q) => q.eq('companyId', state.companyId))
				.unique())!._id
	);
	return { ...state, itemId };
}

async function prepareApproval(
	{
		t,
		membershipId,
		itemId
	}: Pick<Awaited<ReturnType<typeof fixture>>, 't' | 'membershipId' | 'itemId'>,
	id: Id<'savedContracts'>
) {
	await t.mutation(api.savedContracts.saveChoices, {
		membershipId,
		id,
		selectedConcessions: { [itemId]: 'preferred' },
		selectionLifecycles: { [itemId]: `save:${itemId}` },
		expectedRevision: 0,
		operationId: 'save'
	});
	const request = await t.mutation(api.approvals.request, {
		membershipId,
		id,
		expectedRevision: 1
	});
	const stored = await t.run(({ db }) =>
		db
			.query('approvalRequests')
			.withIndex('by_contractId', (q) => q.eq('contractId', id))
			.unique()
	);
	if (!stored || stored.id !== request.id || !('deliveryId' in stored))
		throw new Error('approval delivery missing');
	const delivery = await t.mutation(internal.emailDeliveries.prepare, {
		id: stored.deliveryId,
		attempt: 1
	});
	if (!delivery) throw new Error('approval delivery unavailable');
	const event = delivery.delivery.event;
	if (event.kind !== 'approval') throw new Error('wrong delivery kind');
	const snapshot = await t.query(api.templates.version, {
		membershipId,
		versionId: event.templateVersionId
	});
	const selectionDetails = delivery.selections.map((selection) => {
		const item = snapshot.items.find((item) => item._id === selection.itemId)!;
		return {
			description: item.concessions.find((c) => c.id === selection.concessionId)!.description,
			requiresApproval: Boolean(item.instructions?.changesNeedApproval?.trim()),
			reviewStatus: selection.reviewStatus
		};
	});
	return { event, selections: delivery.selections, selectionDetails };
}

const operationId = '11111111-1111-1111-1111-111111111111';
describe('immutable template creation', () => {
	it('bootstraps atomically and concurrently without replacing the pointer', async () => {
		const { t, companyId } = await emptyFixture();
		const [first, second] = await Promise.all([
			finishTemplate(t, companyId),
			finishTemplate(t, companyId)
		]);
		expect(first).toBe(second);
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(1);
	});
	it('publishes instruction changes once and preserves old content and deleted receipts', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		const first = await finishTemplate(t, companyId);
		const created = await t.mutation(api.savedContracts.create, {
			membershipId,
			companyName: 'Buyer',
			operationId
		});
		if (created.status !== 'created') throw new Error('creation failed');
		const saved = await t.mutation(api.admin.savePlaybookItem, {
			membershipId,
			id: itemId,
			item: { ...item, instructions: { changesNeedApproval: 'Different wording.' } },
			expectedRevision: 1,
			operationId
		});
		expect(saved.status).toBe('saved');
		await t.mutation(api.admin.savePlaybookItem, {
			membershipId,
			id: itemId,
			item,
			expectedRevision: 1,
			operationId
		});
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(2);
		const state = await t.query(api.savedContracts.state, { membershipId, id: created.id });
		const loaded = state && {
			contract: state,
			snapshot: await t.query(api.templates.version, {
				membershipId,
				versionId: state.templateVersionId
			})
		};
		expect(loaded?.snapshot.items[0].instructions?.changesNeedApproval).toBe('Ask first.');
		expect(created.contract.templateVersionId).toBe(first);
		const retry = await t.mutation(api.savedContracts.create, {
			membershipId,
			companyName: 'Other',
			operationId
		});
		expect(retry).toEqual(created);
		const next = await t.mutation(api.savedContracts.create, {
			membershipId,
			companyName: 'Next',
			operationId: 'next'
		});
		expect(next.status).toBe('created');
		if (next.status !== 'created') throw new Error('creation failed');
		expect(next.contract.templateVersionId).not.toBe(first);
		await t.mutation(api.savedContracts.remove, { membershipId, id: created.id });
		expect(
			await t.mutation(api.savedContracts.create, {
				membershipId,
				companyName: 'Buyer',
				operationId
			})
		).toEqual({ status: 'deleted' });
		expect(await t.query(api.templates.version, { membershipId, versionId: first })).toEqual(
			loaded?.snapshot
		);
		await t.mutation(api.admin.deletePlaybookItem, {
			membershipId,
			id: itemId,
			expectedRevision: 2
		});
		await t.mutation(api.admin.deletePlaybookItem, {
			membershipId,
			id: itemId,
			expectedRevision: 2
		});
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(3);
	});
	it('rolls back authoring, revisions, receipts, manifest and pointer on insufficient capacity', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		const first = await finishTemplate(t, companyId);
		await expect(
			t.run(async (ctx) => {
				const captured = await readLiveSnapshot(ctx, companyId);
				const current = (await ctx.db.get('playbookItems', itemId))!;
				const { publishedRevisionId: oldHead, ...historical } = current;
				const proposed = {
					...historical,
					revision: historical.revision + 1,
					instructions: { changesNeedApproval: 'Uncommitted' }
				};
				const publishedRevisionId = await storeItemRevision(ctx, proposed);
				const next = { ...proposed, publishedRevisionId };
				const { _id, _creationTime, ...stored } = next;
				await ctx.db.replace('playbookItems', itemId, stored);
				await ctx.db.insert('creationReceipts', { companyId, operationId: 'uncommitted', itemId });
				captured.items = [next];
				let calls = 0;
				await publishTemplate(
					{
						...ctx,
						meta: {
							...ctx.meta,
							getTransactionMetrics: async () => {
								const metrics = await ctx.meta.getTransactionMetrics();
								// A contract-free draft now replaces its existing manifest instead of
								// allocating a second manifest and moving the pointer. The first
								// capacity gate must still roll every preceding authoring write back.
								if (++calls > 0) metrics.documentsWritten.remaining = 0;
								return metrics;
							}
						}
					},
					companyId,
					captured
				);
			})
		).rejects.toThrow('transaction capacity');
		expect((await t.query(api.templates.current, { membershipId }))?.versionId).toBe(first);
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(1);
		expect(
			await t.run(async ({ db }) => (await db.get('templateVersions', first))!.items)
		).toHaveLength(1);
		expect(await t.run(({ db }) => db.query('playbookItemRevisions').collect())).toHaveLength(1);
		expect(await t.run(({ db }) => db.query('creationReceipts').collect())).toHaveLength(0);
		expect(
			(await t.run(({ db }) => db.get('playbookItems', itemId)))?.instructions?.changesNeedApproval
		).toBe('Ask first.');
	});
	it('creates with contract, receipt and template-freeze writes, one directory write and no template-content reads or compilation', async () => {
		const { t, companyId, membershipId } = await fixture();
		await finishTemplate(t, companyId);
		const counts = { writes: 0, directoryWrites: 0, content: 0 };
		await t.run((ctx) => {
			const db = new Proxy(ctx.db, {
				get(target, key) {
					const value = Reflect.get(target, key);
					if (typeof value !== 'function') return value;
					return (...args: unknown[]) => {
						if (['insert', 'patch', 'replace', 'delete'].includes(String(key))) {
							if (args[0] === 'contractDirectory') counts.directoryWrites++;
							else counts.writes++;
						}
						if (key === 'query' && /Blocks|Items|baselineChunks/.test(String(args[0])))
							counts.content++;
						return value.apply(target, args);
					};
				}
			});
			return (
				create as unknown as {
					_handler: (
						ctx: MutationCtx,
						args: { companyName: string; operationId: string; membershipId: typeof membershipId }
					) => Promise<unknown>;
				}
			)._handler({ ...ctx, db }, { membershipId, companyName: 'Buyer', operationId });
		});
		expect(counts).toEqual({ writes: 3, directoryWrites: 1, content: 0 });
	});
	it('captures approval statuses against shared versions; blocks company holds', async () => {
		const { t, itemId, profileId, companyId, membershipId } = await fixture();
		await finishTemplate(t, companyId);
		const created = await t.mutation(api.savedContracts.create, {
			membershipId,
			companyName: 'Buyer',
			operationId
		});
		if (created.status !== 'created') throw new Error('creation failed');
		// Rep selections enter review; admin selections are automatically approved.
		await t.run(({ db }) => db.patch('profiles', profileId, { role: 'rep' }));
		const { event, selections, selectionDetails } = await prepareApproval(
			{ t, membershipId, itemId },
			created.id
		);
		expect(selectionDetails).toEqual([
			{ description: 'Synthetic choice.', requiresApproval: true, reviewStatus: 'pending' }
		]);
		expect(contractNotification('https://app.example.com', event, selections)).toEqual({
			kind: 'approval',
			data: {
				companyName: 'Buyer',
				url: `https://app.example.com/contracts/${created.id}?review=1`,
				pendingCount: 1,
				reviewedCount: 0,
				notRequiredCount: 0
			}
		});
		await t.run(({ db }) => db.patch('profiles', profileId, { role: 'admin' }));
		const holdId = await t.run(({ db }) =>
			db.insert('companyDeletions', {
				companyId,
				issuer: identity.issuer,
				clerkId: identity.subject,
				attemptId: 'hold',
				requestedAt: Date.now(),
				status: 'prepared',
				phase: 'invitations',
				cleanupGeneration: 0
			})
		);
		await expect(
			t.mutation(api.savedContracts.create, {
				membershipId,
				companyName: 'Buyer',
				operationId: 'blocked'
			})
		).rejects.toThrow('paused');
		await expect(
			t.mutation(api.admin.deletePlaybookItem, { membershipId, id: itemId, expectedRevision: 1 })
		).rejects.toThrow('paused');
		await t.run(async (ctx) => {
			await ctx.db.delete('companyDeletions', holdId);
			await publishTemplate(ctx, companyId, await readLiveSnapshot(ctx, companyId));
		});
		expect((await t.query(api.templates.current, { membershipId }))?.versionId).not.toBe(
			created.contract.templateVersionId
		);
	});
	it('keeps saved versions readable for saving and approval after live item deletion', async () => {
		const { t, itemId, profileId, companyId, membershipId } = await fixture();
		await finishTemplate(t, companyId);
		const created = await t.mutation(api.savedContracts.create, {
			membershipId,
			companyName: 'Buyer',
			operationId
		});
		if (created.status !== 'created') throw new Error('creation failed');
		const id = created.id;
		await t.mutation(api.admin.deletePlaybookItem, {
			membershipId,
			id: itemId,
			expectedRevision: 1
		});
		expect(
			(
				await t.query(api.templates.version, {
					membershipId,
					versionId: (await t.query(api.savedContracts.state, { membershipId, id }))!
						.templateVersionId
				})
			).items[0]._id
		).toBe(itemId);
		// Rep selections enter review; admin selections are automatically approved.
		await t.run(({ db }) => db.patch('profiles', profileId, { role: 'rep' }));
		const { event, selections, selectionDetails } = await prepareApproval(
			{ t, membershipId, itemId },
			id
		);
		expect(selectionDetails).toEqual([
			{ description: 'Synthetic choice.', requiresApproval: true, reviewStatus: 'pending' }
		]);
		expect(contractNotification('https://app.example.com', event, selections)).toEqual({
			kind: 'approval',
			data: {
				companyName: 'Buyer',
				url: `https://app.example.com/contracts/${id}?review=1`,
				pendingCount: 1,
				reviewedCount: 0,
				notRequiredCount: 0
			}
		});
	});
	it('rejects invalid complete templates without publishing or changing live authoring', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		const first = await finishTemplate(t, companyId);
		await expect(
			t.mutation(api.admin.savePlaybookItem, {
				membershipId,
				id: itemId,
				item: {
					...item,
					trigger: {
						id: 'invalid',
						range: {
							start: { sourceKey: 'missing', offset: 0 },
							end: { sourceKey: 'missing', offset: 1 }
						}
					}
				},
				expectedRevision: 1,
				operationId
			})
		).rejects.toThrow();
		expect((await t.query(api.templates.current, { membershipId }))?.versionId).toBe(first);
		expect((await t.run(({ db }) => db.get('playbookItems', itemId)))?.trigger).toEqual(
			normalizePlaybookItem(item).trigger
		);
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(1);
	});
	it('a bootstrap retry cannot replace an admin publication in a race', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		const first = await finishTemplate(t, companyId);
		const [bootstrap, authoring] = await Promise.allSettled([
			finishTemplate(t, companyId),
			t.mutation(api.admin.savePlaybookItem, {
				membershipId,
				id: itemId,
				item: { ...item, instructions: { changesNeedApproval: 'Newest' } },
				expectedRevision: 1,
				operationId
			})
		]);
		expect(authoring.status).toBe('fulfilled');
		if (bootstrap.status === 'fulfilled') expect(bootstrap.value).toBe(first);
		else
			expect(String(bootstrap.reason)).toContain(
				'This company already has template data or another import. Refusing to overwrite it.'
			);
		const current = await t.query(api.templates.current, { membershipId });
		expect(
			(await t.query(api.templates.version, { membershipId, versionId: current!.versionId }))
				.items[0].instructions?.changesNeedApproval
		).toBe('Newest');
		const versions = await t.run(({ db }) => db.query('templateVersions').collect());
		await expect(finishTemplate(t, companyId)).rejects.toThrow(
			'This company already has template data or another import. Refusing to overwrite it.'
		);
		expect((await t.query(api.templates.current, { membershipId }))?.versionId).toBe(
			current?.versionId
		);
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(
			versions.length
		);
	});
});
