// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../src/convex/_generated/api';
import schema from '../../src/convex/schema';
import { canonicalBaselineFingerprint } from '../../src/convex/baselineStorage';
import { currentPointer, publishTemplate, readLiveSnapshot } from '../../src/convex/templates';
import { storeItemRevision } from '../../src/convex/playbookItemRevisions';
import { create } from '../../src/convex/savedContracts';
import type { MutationCtx } from '../../src/convex/_generated/server';
import type { Id } from '../../src/convex/_generated/dataModel';
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

vi.mock('../../src/convex/approvalEmail', async () => {
	const { internalAction } = await import('../../src/convex/_generated/server');
	const { v } = await import('convex/values');
	return {
		send: internalAction({
			args: { id: v.id('savedContracts'), requestId: v.string() },
			returns: v.null(),
			handler: async () => null
		})
	};
});
const modules = import.meta.glob('../../src/convex/**/*.*s');
const importKey = 'a'.repeat(64);
async function fixture() {
	const t = convexTest(schema, modules).withIdentity(identity);
	const { profileId, companyId, membershipId } = await t.run(initializeViewer);
	const itemId = await t.run(async (ctx) => {
		const { db } = ctx;
		await db.patch('company', companyId, { contractDirectoryReady: true });
		const baselineId = await db.insert('baselines', {
			companyId,
			state: 'prepared',
			source: 'seed',
			fingerprint: canonicalBaselineFingerprint([block]),
			issues: [],
			blockCount: 1
		});
		await db.insert('contractBlocks', { ...block, companyId, baselineId });
		await db.insert('currentTemplate', {
			companyId,
			baselineId,
			maintenance: true,
			importKey,
			importBlockCount: 1,
			importItemCount: 1
		});
		const id = await db.insert('playbookItems', {
			...item,
			revision: 1,
			companyId,
			instructions: { changesNeedApproval: 'Ask first.' }
		});
		await db.patch('playbookItems', id, {
			publishedRevisionId: await storeItemRevision(ctx, (await db.get('playbookItems', id))!)
		});
		return id;
	});
	return { t, itemId, profileId, companyId, membershipId };
}
async function finishTemplate(
	t: Awaited<ReturnType<typeof fixture>>['t'],
	companyId: Id<'company'>
) {
	await t.mutation(internal.companyTemplateImport.finish, {
		companyId,
		importKey,
		blockCount: 1,
		itemCount: 1
	});
	return (await t.run((ctx) => currentPointer(ctx, companyId)))!.versionId!;
}
const operationId = '11111111-1111-1111-1111-111111111111';
describe('immutable template creation', () => {
	it('finishes an import atomically and concurrently without replacing the pointer', async () => {
		const { t, companyId, membershipId } = await fixture();
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
								if (++calls > 2) metrics.documentsWritten.remaining = 0;
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
		expect(await t.run(({ db }) => db.query('templateVersionItems').collect())).toHaveLength(1);
		expect(await t.run(({ db }) => db.query('playbookItemRevisions').collect())).toHaveLength(1);
		expect(await t.run(({ db }) => db.query('creationReceipts').collect())).toHaveLength(0);
		expect(
			(await t.run(({ db }) => db.get('playbookItems', itemId)))?.instructions?.changesNeedApproval
		).toBe('Ask first.');
	});
	it('creates with two contract/receipt writes, one directory write and no template-content reads or compilation', async () => {
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
		expect(counts).toEqual({ writes: 2, directoryWrites: 1, content: 0 });
	});
	it('saves and reads approval descriptions from shared versions; blocks maintenance', async () => {
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
		await t.mutation(api.savedContracts.saveChoices, {
			membershipId,
			id: created.id,
			selectedConcessions: { [itemId]: 'preferred' },
			selectionLifecycles: { [itemId]: `save:${itemId}` },
			expectedRevision: 0,
			operationId: 'save'
		});
		const request = await t.mutation(api.approvals.request, {
			membershipId,
			id: created.id,
			expectedRevision: 1
		});
		const stored = await t.run(({ db }) =>
			db
				.query('approvalRequests')
				.withIndex('by_contractId', (q) => q.eq('contractId', created.id))
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
		const descriptions = await t.query(internal.emailSnapshots.descriptions, {
			templateVersionId: event.templateVersionId,
			companyId: delivery.delivery.companyId,
			selections: delivery.selections
		});
		expect(
			descriptions.map((description, index) => ({
				...description,
				reviewStatus: delivery.selections[index].reviewStatus
			}))
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
			t.mutation(api.admin.deletePlaybookItem, { membershipId, id: itemId, expectedRevision: 1 })
		).rejects.toThrow('maintenance');
		await t.run(async (ctx) => {
			await publishTemplate(ctx, companyId, await readLiveSnapshot(ctx, companyId));
			const pointer = (await currentPointer(ctx, companyId))!;
			await ctx.db.patch('currentTemplate', pointer._id, { maintenance: false });
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
		const descriptions = await t.query(internal.emailSnapshots.descriptions, {
			templateVersionId: event.templateVersionId,
			companyId: delivery.delivery.companyId,
			selections: delivery.selections
		});
		expect(
			descriptions.map((description, index) => ({
				...description,
				reviewStatus: delivery.selections[index].reviewStatus
			}))
		).toEqual([
			{ description: 'Synthetic choice.', requiresApproval: true, reviewStatus: 'pending' }
		]);
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
				expectedRevision: 1,
				operationId
			})
		).rejects.toThrow();
		expect((await t.query(api.templates.current, { membershipId }))?.versionId).toBe(first);
		expect((await t.run(({ db }) => db.get('playbookItems', itemId)))?.triggers).toEqual(
			item.triggers
		);
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(1);
	});
	it('an import retry cannot replace an admin publication in a race', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		await finishTemplate(t, companyId);
		await Promise.all([
			finishTemplate(t, companyId),
			t.mutation(api.admin.savePlaybookItem, {
				membershipId,
				id: itemId,
				item: { ...item, instructions: { changesNeedApproval: 'Newest' } },
				expectedRevision: 1,
				operationId
			})
		]);
		const current = await t.query(api.templates.current, { membershipId });
		expect(
			(await t.query(api.templates.version, { membershipId, versionId: current!.versionId }))
				.items[0].instructions?.changesNeedApproval
		).toBe('Newest');
		expect(await finishTemplate(t, companyId)).toBe(current?.versionId);
	});
});
