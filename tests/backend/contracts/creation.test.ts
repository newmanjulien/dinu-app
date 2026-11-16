import { fixtureOperationId } from '../../support/operation';
import { isRepItem, type TemplateItem } from '../../../src/lib/playbook/model';
function repItem<T extends TemplateItem>(item: T) {
	if (!isRepItem(item)) throw new Error('Expected rep instructions');
	return item;
}
// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from '../../../src/convex/_generated/api';
import type { Id } from '../../../src/convex/_generated/dataModel';
import type { MutationCtx } from '../../../src/convex/_generated/server';
import { create } from '../../../src/convex/contracts';
import { contractNotification } from '../../../src/convex/emailNotifications';
import { hydrateHead } from '../../../src/convex/playbookItemRevisions';
import schema from '../../../src/convex/schema';
import { saveTemplateVersion, readLiveSnapshot } from '../../../src/convex/templates';
import { item as baseItem, block, identity, initializeViewer } from '../../support/contract-data';
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

const modules = import.meta.glob('../../../src/convex/**/*.*s');
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
	await t.mutation(api.contracts.saveChanges, {
		membershipId,
		id,
		operationId: fixtureOperationId('save'),
		commands: [
			{
				id: fixtureOperationId('save-command'),
				itemId,
				expectedCurrentChangeId: null,
				action: { kind: 'set', optionId: 'preferred' },
				occurredAt: Date.now()
			}
		]
	});
	const state = await t.query(api.contracts.state, { membershipId, id });
	if (!state) throw new Error('Contract missing');
	const result = await t.mutation(api.contractApprovals.request, {
		membershipId,
		id,
		context: 'playbook',
		expectedDocument: { documentId: state.documentId, documentRevision: state.documentRevision },
		expectedIdentity: state.reviews.playbook.identity,
		operationId: fixtureOperationId('request-approval')
	});
	if (result.status !== 'complete' || !result.request)
		throw new Error('Request is still preparing');
	const request = result.request;
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
	const entries = await t.query(api.contractApprovals.entries, {
		membershipId,
		id,
		context: 'playbook',
		requestId: request.id,
		paginationOpts: { cursor: null, numItems: 8 }
	});
	const selectionDetails = await Promise.all(
		entries.page.map(async (selection) => {
			if (selection.source.kind !== 'playbook') throw new Error('Expected frozen Playbook source');
			const change = await t.run(({ db }) => db.get('contractChanges', selection.changeId));
			return {
				description: selection.source.value.description,
				requiresApproval: change?.policy === 'required',
				reviewStatus: selection.status
			};
		})
	);
	const counts = {
		pendingCount: entries.page.filter((entry) => entry.status === 'pending').length,
		reviewedCount: entries.page.filter((entry) => entry.status !== 'pending').length,
		notRequiredCount: 0,
		approvedCount: 0,
		rejectedCount: 0
	};
	return { event, selections: counts, selectionDetails };
}

const templateOperationId = '11111111-1111-1111-1111-111111111111';
const operationId = fixtureOperationId('contract-creation');
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
			title: 'Buyer',
			operationId
		});
		if (created.status !== 'created') throw new Error('creation failed');
		const saved = await t.mutation(api.playbookItems.saveTemplateItem, {
			membershipId,
			id: itemId,
			item: {
				...item,
				approvalPolicy: { kind: 'required' as const, instructions: 'Different wording.' }
			},
			expectedContentRevision: 1,
			operationId: templateOperationId
		});
		expect(saved.status).toBe('saved');
		await t.mutation(api.playbookItems.saveTemplateItem, {
			membershipId,
			id: itemId,
			item,
			expectedContentRevision: 1,
			operationId: templateOperationId
		});
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(2);
		const state = await t.query(api.contracts.state, { membershipId, id: created.id });
		const loaded = state && {
			contract: state,
			snapshot: await t.query(api.templates.frozenContent, {
				membershipId,
				versionId: state.templateVersionId
			})
		};
		expect(loaded && repItem(loaded.snapshot.items[0]).approvalPolicy).toEqual({
			kind: 'required',
			instructions: 'Ask first.'
		});
		expect(created.contract.templateVersionId).toBe(first);
		const retry = await t.mutation(api.contracts.create, {
			membershipId,
			title: 'Buyer',
			operationId
		});
		expect(retry).toEqual(created);
		const next = await t.mutation(api.contracts.create, {
			membershipId,
			title: 'Next',
			operationId: fixtureOperationId('next')
		});
		expect(next.status).toBe('created');
		if (next.status !== 'created') throw new Error('creation failed');
		expect(next.contract.templateVersionId).not.toBe(first);
		await t.mutation(api.contracts.remove, { membershipId, id: created.id });
		expect(
			await t.mutation(api.contracts.create, {
				membershipId,
				title: 'Buyer',
				operationId
			})
		).toEqual({ status: 'deleted' });
		expect(await t.query(api.templates.content, { membershipId, versionId: first })).toEqual(
			loaded?.snapshot
		);
		await t.mutation(api.playbookItems.deleteTemplateItem, {
			membershipId,
			id: itemId,
			expectedContentRevision: 2
		});
		await t.mutation(api.playbookItems.deleteTemplateItem, {
			membershipId,
			id: itemId,
			expectedContentRevision: 2
		});
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(3);
	});
	it('rejects a template snapshot when transaction capacity is exhausted', async () => {
		const { t, companyId } = await fixture();
		await expect(
			t.run(async (ctx) => {
				const captured = await readLiveSnapshot(ctx, companyId);
				await saveTemplateVersion(
					{
						...ctx,
						meta: {
							...ctx.meta,
							getTransactionMetrics: async () => {
								const metrics = await ctx.meta.getTransactionMetrics();
								metrics.documentsWritten.remaining = 0;
								return metrics;
							}
						}
					},
					companyId,
					captured
				);
			})
		).rejects.toThrow('transaction capacity');
	});
	it('materializes the frozen source once at creation with bounded snapshot writes and one directory write', async () => {
		const { t, companyId, membershipId } = await fixture();
		await finishTemplate(t, companyId);
		const counts = {
			writes: 0,
			rootWrites: 0,
			directoryWrites: 0,
			content: 0,
			documentWrites: 0
		};
		await t.run((ctx) => {
			const db = new Proxy(ctx.db, {
				get(target, key) {
					const value = Reflect.get(target, key);
					if (typeof value !== 'function') return value;
					return (...args: unknown[]) => {
						if (['insert', 'patch', 'replace', 'delete'].includes(String(key))) {
							if (args[0] === 'contractDocuments' || args[0] === 'contractDocumentChunks')
								counts.documentWrites++;
							else if (args[0] === 'savedContracts') counts.rootWrites++;
							else if (args[0] === 'contractDirectory') counts.directoryWrites++;
							else counts.writes++;
						}
						if (
							(key === 'get' || key === 'query') &&
							(args[0] === 'playbookItemRevisions' ||
								args[0] === 'templateSourceChunks' ||
								(key === 'query' && /Blocks|Items/.test(String(args[0]))))
						)
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
							title: string;
							operationId: string;
							membershipId: typeof membershipId;
						}
					) => Promise<unknown>;
				}
			)._handler({ ...ctx, db }, { membershipId, title: 'Buyer', operationId });
		});
		expect(counts).toEqual({
			writes: 2,
			rootWrites: 2,
			directoryWrites: 1,
			content: 1,
			documentWrites: 3
		});
	});
	it('refuses first-link creation when saving advances beyond the flushed revision', async () => {
		const { t, membershipId, itemId } = await fixture();
		const created = await t.mutation(api.contracts.create, {
			membershipId,
			title: 'Buyer',
			operationId
		});
		if (created.status !== 'created') throw new Error('creation failed');
		const saved = await t.mutation(api.contracts.saveChanges, {
			membershipId,
			id: created.id,
			operationId: fixtureOperationId('newer-save'),
			commands: [
				{
					id: fixtureOperationId('newer-save-command'),
					itemId,
					expectedCurrentChangeId: null,
					action: { kind: 'set', optionId: 'preferred' },
					occurredAt: 123
				}
			]
		});
		expect(saved.status).toBe('saved');
		await expect(
			t.mutation(internal.buyerLinks.capture, {
				membershipId,
				id: created.id,
				preparation: {
					kind: 'prepared',
					operationId: fixtureOperationId('first-link'),
					expectedState: {
						stateRevision: created.contract.stateRevision,
						documentId: created.contract.documentId,
						documentRevision: created.contract.documentRevision
					}
				},
				token: 'Ab3Cd4Ef5Gh6I'
			})
		).rejects.toThrow('The saved contract changed.');
		expect(await t.query(api.buyerLinks.latest, { membershipId, id: created.id })).toBeNull();
	});
	it('captures approval statuses against shared versions; blocks company holds', async () => {
		const { t, itemId, profileId, companyId, membershipId } = await fixture();
		await finishTemplate(t, companyId);
		const created = await t.mutation(api.contracts.create, {
			membershipId,
			title: 'Buyer',
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
				title: 'Buyer',
				operationId: fixtureOperationId('blocked')
			})
		).rejects.toThrow('paused');
		await expect(
			t.mutation(api.playbookItems.deleteTemplateItem, {
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
			title: 'Buyer',
			operationId
		});
		if (created.status !== 'created') throw new Error('creation failed');
		const id = created.id;
		await t.mutation(api.playbookItems.deleteTemplateItem, {
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
			t.mutation(api.playbookItems.saveTemplateItem, {
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
				operationId: templateOperationId
			})
		).resolves.toMatchObject({ status: 'rejected' });
		expect((await t.query(api.templates.current, { membershipId }))?.versionId).toBe(first);
		expect(
			repItem(
				await t.run(async (ctx) => hydrateHead(ctx, (await ctx.db.get('playbookItems', itemId))!))
			).trigger
		).toEqual(item.trigger);
		expect(await t.run(({ db }) => db.query('templateVersions').collect())).toHaveLength(1);
	});
	it('a bootstrap retry cannot replace an admin snapshot in a race', async () => {
		const { t, itemId, companyId, membershipId } = await fixture();
		const first = await finishTemplate(t, companyId);
		const [bootstrap, authoring] = await Promise.allSettled([
			finishTemplate(t, companyId),
			t.mutation(api.playbookItems.saveTemplateItem, {
				membershipId,
				id: itemId,
				item: { ...item, approvalPolicy: { kind: 'required' as const, instructions: 'Newest' } },
				expectedContentRevision: 1,
				operationId: templateOperationId
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
			repItem(
				(await t.query(api.templates.content, { membershipId, versionId: current!.versionId }))
					.items[0]
			).approvalPolicy
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
