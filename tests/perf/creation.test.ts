// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../src/convex/_generated/api';
import schema from '../../src/convex/schema';
import { currentPointer, publishTemplate } from '../../src/convex/templates';
import { create } from '../../src/convex/savedContracts';
import type { MutationCtx } from '../../src/convex/_generated/server';
import { block, item as baseItem, identity, initializeViewer } from './fixtures';
const item = {
	...baseItem,
	triggers: [
		{
			id: 'trigger',
			range: { start: { sourceKey: 'text-1', offset: 0 }, end: { sourceKey: 'text-1', offset: 9 } }
		}
	]
};

vi.mock('../../src/convex/approvalEmail', () => ({ send: { _handler: vi.fn() } }));
const modules = import.meta.glob('../../src/convex/**/*.*s');
async function fixture() {
	const t = convexTest(schema, modules).withIdentity(identity);
	const { profileId, companyId, membershipId } = await t.run(initializeViewer);
	const itemId = await t.run(async ({ db }) => {
		await db.insert('contractBlocks', { ...block, companyId });
		return db.insert('playbookItems', {
			...item,
			companyId,
			instructions: { changesNeedApproval: 'Ask first.' }
		});
	});
	return { t, itemId, profileId, companyId, membershipId };
}
const operationId = '11111111-1111-1111-1111-111111111111';
describe('immutable template creation', () => {
	it('initializes atomically and concurrently without replacing the pointer', async () => {
		const { t, companyId, membershipId } = await fixture();
		const [first, second] = await Promise.all([
			t.mutation(internal.templates.initialize, { companyId }),
			t.mutation(internal.templates.initialize, { companyId })
		]);
		expect(first).toBe(second);
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(1);
	});
	it('publishes instruction changes once and preserves old content and deleted receipts', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		const first = await t.mutation(internal.templates.initialize, { companyId });
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
			expectedRevision: 0,
			operationId
		});
		expect(saved.status).toBe('saved');
		await t.mutation(api.admin.savePlaybookItem, {
			membershipId,
			id: itemId,
			item,
			expectedRevision: 0,
			operationId
		});
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(2);
		const loaded = await t.query(api.savedContracts.load, { membershipId, id: created.id });
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
		expect(next.status === 'created' && next.contract.templateVersionId).not.toBe(first);
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
			expectedRevision: 1
		});
		await t.mutation(api.admin.deletePlaybookItem, {
			membershipId,
			id: itemId,
			expectedRevision: 1
		});
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(3);
	});
	it('rolls back authoring, partial copies and pointer on insufficient capacity', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		const first = await t.mutation(internal.templates.initialize, { companyId });
		await expect(
			t.run(async (ctx) => {
				await ctx.db.patch('playbookItems', itemId, {
					instructions: { changesNeedApproval: 'Uncommitted' }
				});
				let calls = 0;
				await publishTemplate(
					{
						...ctx,
						meta: {
							...ctx.meta,
							getTransactionMetrics: async () => {
								const metrics = await ctx.meta.getTransactionMetrics();
								if (++calls > 1) metrics.documentsWritten.remaining = 0;
								return metrics;
							}
						}
					},
					(await ctx.db.get('company', companyId))!
				);
			})
		).rejects.toThrow('transaction capacity');
		expect((await t.query(api.templates.current, { membershipId }))?.versionId).toBe(first);
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(1);
		expect(
			(await t.run(({ db }) => db.get('playbookItems', itemId)))?.instructions?.changesNeedApproval
		).toBe('Ask first.');
	});
	it('creates with two writes and no template-content reads or compilation', async () => {
		const { t, companyId, membershipId } = await fixture();
		await t.mutation(internal.templates.initialize, { companyId });
		const counts = { writes: 0, content: 0 };
		await t.run((ctx) => {
			const db = new Proxy(ctx.db, {
				get(target, key) {
					const value = Reflect.get(target, key);
					if (typeof value !== 'function') return value;
					return (...args: unknown[]) => {
						if (['insert', 'patch', 'replace', 'delete'].includes(String(key))) counts.writes++;
						if (key === 'query' && /Blocks|Items/.test(String(args[0]))) counts.content++;
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
		expect(counts).toEqual({ writes: 2, content: 0 });
	});
	it('saves and reads approval descriptions from shared versions; blocks maintenance', async () => {
		const { t, itemId, profileId, companyId, membershipId } = await fixture();
		await t.mutation(internal.templates.initialize, { companyId });
		const created = await t.mutation(api.savedContracts.create, {
			membershipId,
			companyName: 'Buyer',
			operationId
		});
		if (created.status !== 'created') throw new Error('creation failed');
		// Rep selections enter review; admin selections are automatically approved.
		await t.run(({ db }) => db.patch('profiles', profileId, { role: 'rep' }));
		await t.mutation(api.savedContracts.saveChoices, {
			membershipId,
			id: created.id,
			selectedConcessions: { [itemId]: 'preferred' },
			expectedRevision: 0,
			operationId: 'save'
		});
		const request = await t.mutation(api.approvals.request, {
			membershipId,
			id: created.id,
			expectedRevision: 1
		});
		const delivery = await t.query(internal.approvals.forSend, {
			id: created.id,
			requestId: request.id
		});
		if (!delivery) throw new Error('approval delivery unavailable');
		expect(
			await t.query(internal.approvals.descriptions, {
				templateVersionId: delivery.templateVersionId,
				selectedConcessions: delivery.selectedConcessions
			})
		).toEqual([
			{ description: 'Synthetic choice.', requiresApproval: true, reviewStatus: 'pending' }
		]);
		await t.run(({ db }) => db.patch('profiles', profileId, { role: 'admin' }));
		await t.run(async (ctx) => {
			const pointer = (await currentPointer(ctx, companyId))!;
			await ctx.db.patch('currentTemplate', pointer._id, { maintenance: true });
		});
		await expect(
			t.mutation(api.savedContracts.create, {
				membershipId,
				companyName: 'Buyer',
				operationId: 'blocked'
			})
		).rejects.toThrow('maintenance');
		await expect(
			t.mutation(api.admin.deletePlaybookItem, { membershipId, id: itemId, expectedRevision: 0 })
		).rejects.toThrow('maintenance');
		await t.run(async (ctx) => {
			await publishTemplate(ctx, (await ctx.db.get('company', companyId))!);
			const pointer = (await currentPointer(ctx, companyId))!;
			await ctx.db.patch('currentTemplate', pointer._id, { maintenance: false });
		});
		expect((await t.query(api.templates.current, { membershipId }))?.versionId).not.toBe(
			created.contract.templateVersionId
		);
	});
	it('keeps saved versions readable for saving and approval after live item deletion', async () => {
		const { t, itemId, profileId, companyId, membershipId } = await fixture();
		await t.mutation(internal.templates.initialize, { companyId });
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
			expectedRevision: 0
		});
		expect(
			(await t.query(api.savedContracts.load, { membershipId, id }))?.snapshot.items[0]._id
		).toBe(itemId);
		// Rep selections enter review; admin selections are automatically approved.
		await t.run(({ db }) => db.patch('profiles', profileId, { role: 'rep' }));
		await t.mutation(api.savedContracts.saveChoices, {
			membershipId,
			id,
			selectedConcessions: { [itemId]: 'preferred' },
			expectedRevision: 0,
			operationId: 'save'
		});
		const request = await t.mutation(api.approvals.request, {
			membershipId,
			id,
			expectedRevision: 1
		});
		const delivery = await t.query(internal.approvals.forSend, { id, requestId: request.id });
		if (!delivery) throw new Error('approval delivery unavailable');
		expect(
			await t.query(internal.approvals.descriptions, {
				templateVersionId: delivery.templateVersionId,
				selectedConcessions: delivery.selectedConcessions
			})
		).toEqual([
			{ description: 'Synthetic choice.', requiresApproval: true, reviewStatus: 'pending' }
		]);
	});
	it('rejects invalid complete templates without publishing or changing live authoring', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		const first = await t.mutation(internal.templates.initialize, { companyId });
		await expect(
			t.mutation(api.admin.savePlaybookItem, {
				membershipId,
				id: itemId,
				item: {
					...item,
					triggers: [
						{
							id: 'invalid',
							range: {
								start: { sourceKey: 'missing', offset: 0 },
								end: { sourceKey: 'missing', offset: 1 }
							}
						}
					]
				},
				expectedRevision: 0,
				operationId
			})
		).rejects.toThrow();
		expect((await t.query(api.templates.current, { membershipId }))?.versionId).toBe(first);
		expect((await t.run(({ db }) => db.get('playbookItems', itemId)))?.triggers).toEqual(
			item.triggers
		);
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(1);
	});
	it('initialization cannot replace an admin publication in a race', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		await Promise.all([
			t.mutation(internal.templates.initialize, { companyId }),
			t.mutation(api.admin.savePlaybookItem, {
				membershipId,
				id: itemId,
				item: { ...item, instructions: { changesNeedApproval: 'Newest' } },
				expectedRevision: 0,
				operationId
			})
		]);
		const current = await t.query(api.templates.current, { membershipId });
		expect(current?.snapshot.items[0].instructions?.changesNeedApproval).toBe('Newest');
		expect(await t.mutation(internal.templates.initialize, { companyId })).toBe(current?.versionId);
	});
});
