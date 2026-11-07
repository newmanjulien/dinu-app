// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from '../../src/convex/_generated/api';
import type { Id } from '../../src/convex/_generated/dataModel';
import type { MutationCtx } from '../../src/convex/_generated/server';
import { create } from '../../src/convex/contracts';
import { contractNotification } from '../../src/convex/emailNotifications';
import {
	storeItemRevision,
	hydrateHead,
	compactHead
} from '../../src/convex/playbookItemRevisions';
import schema from '../../src/convex/schema';
import { saveTemplateVersion, readLiveSnapshot } from '../../src/convex/templates';
import { item as baseItem, block, identity, initializeViewer } from './fixtures';
const item: typeof baseItem = {
	...baseItem,
	trigger: {
		id: 'trigger',
		target: {
			kind: 'text',
			range: { start: { sourceKey: 'text-1', offset: 0 }, end: { sourceKey: 'text-1', offset: 9 } }
		}
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
	const setup = await t.mutation(internal.operator.bootstrap, {
		companyId,
		blocks: [block],
		items: [{ ...item, approvalPolicy: { kind: 'required' as const, instructions: 'Ask first.' } }]
	});
	await t.mutation(internal.authoringValidation.certify, { companyId, versionId: setup.versionId });
	return setup.versionId;
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
	await t.mutation(api.contracts.saveChoices, {
		membershipId,
		id,
		choices: { [itemId]: { concessionId: 'preferred', applicationId: `save:${itemId}` } },
		expectedEditRevision: 0,
		operationId: 'save',
		commands: [
			{
				id: 'save-command',
				itemId,
				choice: { concessionId: 'preferred', applicationId: `save:${itemId}` },
				occurredAt: Date.now()
			}
		]
	});
	const request = await t.mutation(api.contractApprovals.request, {
		membershipId,
		id,
		expectedEditRevision: 1,
		operationId: 'request-approval'
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
	const snapshot = await t.query(api.templates.content, {
		membershipId,
		versionId: event.templateVersionId
	});
	const selectionDetails = delivery.selections.map((selection) => {
		const item = snapshot.items.find((item) => item._id === selection.itemId)!;
		return {
			description: item.concessions.find((c) => c.id === selection.concessionId)!.description,
			requiresApproval: item.approvalPolicy.kind === 'required',
			reviewStatus: selection.approval?.status
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
	it('saves instruction changes once and preserves old content and deleted receipts', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		const first = await finishTemplate(t, companyId);
		const created = await t.mutation(api.contracts.create, {
			membershipId,
			buyerCompanyName: 'Buyer',
			operationId
		});
		if (created.status !== 'created') throw new Error('creation failed');
		const saved = await t.mutation(api.playbookItems.savePlaybookItem, {
			membershipId,
			id: itemId,
			item: {
				...item,
				approvalPolicy: { kind: 'required' as const, instructions: 'Different wording.' }
			},
			expectedContentRevision: 1,
			operationId
		});
		expect(saved.status).toBe('saved');
		await t.mutation(api.playbookItems.savePlaybookItem, {
			membershipId,
			id: itemId,
			item,
			expectedContentRevision: 1,
			operationId
		});
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(2);
		const state = await t.query(api.contracts.state, { membershipId, id: created.id });
		const loaded = state && {
			contract: state,
			snapshot: await t.query(api.templates.content, {
				membershipId,
				versionId: state.templateVersionId
			})
		};
		expect(loaded?.snapshot.items[0].approvalPolicy).toEqual({
			kind: 'required',
			instructions: 'Ask first.'
		});
		expect(created.contract.templateVersionId).toBe(first);
		const retry = await t.mutation(api.contracts.create, {
			membershipId,
			buyerCompanyName: 'Other',
			operationId
		});
		expect(retry).toEqual(created);
		const next = await t.mutation(api.contracts.create, {
			membershipId,
			buyerCompanyName: 'Next',
			operationId: 'next'
		});
		expect(next.status).toBe('created');
		if (next.status !== 'created') throw new Error('creation failed');
		expect(next.contract.templateVersionId).not.toBe(first);
		await t.mutation(api.contracts.remove, { membershipId, id: created.id });
		expect(
			await t.mutation(api.contracts.create, {
				membershipId,
				buyerCompanyName: 'Buyer',
				operationId
			})
		).toEqual({ status: 'deleted' });
		expect(await t.query(api.templates.content, { membershipId, versionId: first })).toEqual(
			loaded?.snapshot
		);
		await t.mutation(api.playbookItems.deletePlaybookItem, {
			membershipId,
			id: itemId,
			expectedContentRevision: 2
		});
		await t.mutation(api.playbookItems.deletePlaybookItem, {
			membershipId,
			id: itemId,
			expectedContentRevision: 2
		});
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(3);
	});
	it('rolls back authoring, revisions, receipts, manifest and pointer on insufficient capacity', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		const first = await finishTemplate(t, companyId);
		await expect(
			t.run(async (ctx) => {
				const captured = await readLiveSnapshot(ctx, companyId);
				const current = await hydrateHead(ctx, (await ctx.db.get('playbookItems', itemId))!);
				const { currentRevisionId: oldHead, ...historical } = current;
				const proposed = {
					...historical,
					contentRevision: historical.contentRevision + 1,
					approvalPolicy: { kind: 'required' as const, instructions: 'Uncommitted' }
				};
				const currentRevisionId = await storeItemRevision(ctx, proposed);
				const next = { ...proposed, currentRevisionId };
				const { _id, _creationTime, ...stored } = next;
				await ctx.db.replace('playbookItems', itemId, compactHead(next));
				await ctx.db.insert('playbookItemCreationReceipts', {
					companyId,
					operationId: 'uncommitted',
					itemId
				});
				captured.items = [next];
				let calls = 0;
				await saveTemplateVersion(
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
		expect(
			await t.run(({ db }) => db.query('playbookItemCreationReceipts').collect())
		).toHaveLength(0);
		expect(
			(await t.run(async (ctx) => hydrateHead(ctx, (await ctx.db.get('playbookItems', itemId))!)))
				.approvalPolicy
		).toEqual({
			kind: 'required',
			instructions: 'Ask first.'
		});
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
						args: {
							buyerCompanyName: string;
							operationId: string;
							membershipId: typeof membershipId;
						}
					) => Promise<unknown>;
				}
			)._handler({ ...ctx, db }, { membershipId, buyerCompanyName: 'Buyer', operationId });
		});
		expect(counts).toEqual({ writes: 3, directoryWrites: 1, content: 0 });
	});
	it('captures approval statuses against shared versions; blocks company holds', async () => {
		const { t, itemId, profileId, companyId, membershipId } = await fixture();
		await finishTemplate(t, companyId);
		const created = await t.mutation(api.contracts.create, {
			membershipId,
			buyerCompanyName: 'Buyer',
			operationId
		});
		if (created.status !== 'created') throw new Error('creation failed');
		// Rep selections enter review; admin selections are automatically approved.
		await t.run(({ db }) => db.patch('memberships', membershipId, { role: 'rep' }));
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
		await t.run(({ db }) => db.patch('memberships', membershipId, { role: 'admin' }));
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
			t.mutation(api.contracts.create, {
				membershipId,
				buyerCompanyName: 'Buyer',
				operationId: 'blocked'
			})
		).rejects.toThrow('paused');
		await expect(
			t.mutation(api.playbookItems.deletePlaybookItem, {
				membershipId,
				id: itemId,
				expectedContentRevision: 1
			})
		).rejects.toThrow('paused');
		await t.run(async (ctx) => {
			await ctx.db.delete('companyDeletions', holdId);
			await saveTemplateVersion(ctx, companyId, await readLiveSnapshot(ctx, companyId));
		});
		expect((await t.query(api.templates.current, { membershipId }))?.versionId).not.toBe(
			created.contract.templateVersionId
		);
	});
	it('keeps saved versions readable for saving and approval after live item deletion', async () => {
		const { t, itemId, profileId, companyId, membershipId } = await fixture();
		await finishTemplate(t, companyId);
		const created = await t.mutation(api.contracts.create, {
			membershipId,
			buyerCompanyName: 'Buyer',
			operationId
		});
		if (created.status !== 'created') throw new Error('creation failed');
		const id = created.id;
		await t.mutation(api.playbookItems.deletePlaybookItem, {
			membershipId,
			id: itemId,
			expectedContentRevision: 1
		});
		expect(
			(
				await t.query(api.templates.content, {
					membershipId,
					versionId: (await t.query(api.contracts.state, { membershipId, id }))!.templateVersionId
				})
			).items[0]._id
		).toBe(itemId);
		// Rep selections enter review; admin selections are automatically approved.
		await t.run(({ db }) => db.patch('memberships', membershipId, { role: 'rep' }));
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
	it('rejects invalid complete templates without saving or changing live authoring', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		const first = await finishTemplate(t, companyId);
		await expect(
			t.mutation(api.playbookItems.savePlaybookItem, {
				membershipId,
				id: itemId,
				item: {
					...item,
					trigger: {
						id: 'invalid',
						target: {
							kind: 'text',
							range: {
								start: { sourceKey: 'missing', offset: 0 },
								end: { sourceKey: 'missing', offset: 1 }
							}
						}
					}
				},
				expectedContentRevision: 1,
				operationId
			})
		).resolves.toMatchObject({ status: 'rejected' });
		expect((await t.query(api.templates.current, { membershipId }))?.versionId).toBe(first);
		expect(
			(await t.run(async (ctx) => hydrateHead(ctx, (await ctx.db.get('playbookItems', itemId))!)))
				.trigger
		).toEqual(item.trigger);
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(1);
	});
	it('a bootstrap retry cannot replace an admin snapshot in a race', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		const first = await finishTemplate(t, companyId);
		const [bootstrap, authoring] = await Promise.allSettled([
			finishTemplate(t, companyId),
			t.mutation(api.playbookItems.savePlaybookItem, {
				membershipId,
				id: itemId,
				item: { ...item, approvalPolicy: { kind: 'required' as const, instructions: 'Newest' } },
				expectedContentRevision: 1,
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
			(await t.query(api.templates.content, { membershipId, versionId: current!.versionId }))
				.items[0].approvalPolicy
		).toEqual({ kind: 'required', instructions: 'Newest' });
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
