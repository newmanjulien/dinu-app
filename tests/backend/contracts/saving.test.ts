import { fixtureOperationId } from '../../support/operation';
// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { convexToJson, jsonToConvex } from 'convex/values';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../src/convex/_generated/api';
import type { Id } from '../../../src/convex/_generated/dataModel';
import type { MutationCtx } from '../../../src/convex/_generated/server';
import { writeValidationFacts } from '../../../src/convex/authoringValidation';
import {
	templateSourceIntegrity,
	writeTemplateSourceChunks
} from '../../../src/convex/templateSourceStorage';
import { writeDirectory } from '../../../src/convex/contractDirectory';
import { readContract } from '../../../src/convex/contractState';
import { save } from '../../../src/convex/contracts';
import { createAuthoringItem } from '../../../src/convex/playbookItemRevisions';
import schema from '../../../src/convex/schema';
import { concessionSelectionMap } from '../../../src/lib/contract/changes';
import { CompiledDocument } from '../../../src/lib/document/compiled-document';
import { VALIDATION_CODEC_VERSION } from '../../../src/lib/document/validation-codec';
import { block, identity, initializeViewer, item } from '../../support/contract-data';

// Spy at the real compiler boundary, retaining its implementation.
vi.mock('../../../src/lib/document/compiled-document', { spy: true });
const modules = import.meta.glob('../../../src/convex/**/*.*s');

async function fixture(selected = false) {
	const t = convexTest(schema, modules).withIdentity(identity);
	const { profileId, companyId, membershipId } = await t.run(initializeViewer);
	const ids = await t.run(async (ctx) => {
		const { db } = ctx;
		const integrity = templateSourceIntegrity([block]);
		const templateSourceId = await db.insert('templateSources', {
			companyId,
			state: 'active',
			source: 'seed',
			...integrity,
			issues: [],
			blockCount: 1,
			bootstrapKey: 'a'.repeat(64),
			activatedAt: 123,
			chunkCount: 0,
			chunkReadBytes: 0
		});
		await db.patch(
			'templateSources',
			templateSourceId,
			await writeTemplateSourceChunks(ctx, { companyId, templateSourceId, blocks: [block] })
		);
		await writeValidationFacts(ctx, {
			companyId,
			templateSourceId,
			fingerprint: integrity.fingerprint,
			blocks: [block]
		});
		await db.patch('company', companyId, { templateSourceId });
		const firstItem = await createAuthoringItem(ctx, { ...item, companyId });
		const secondItem = await createAuthoringItem(ctx, {
			...item,
			trigger: {
				id: 'trigger-2',
				target: {
					kind: 'text',
					range: {
						start: { sourceKey: 'text-1', offset: 10 },
						end: { sourceKey: 'text-1', offset: 18 }
					}
				}
			},
			concessions: [
				{
					id: 'preferred',
					tier: 'preferred',
					description: 'Second synthetic choice.',
					changes: [
						{
							target: {
								kind: 'text',
								range: {
									start: { sourceKey: 'text-1', offset: 10 },
									end: { sourceKey: 'text-1', offset: 18 }
								}
							},
							replacement: [{ kind: 'text', text: 'agreement' }]
						}
					]
				}
			],
			companyId
		});
		const foreignItem = await createAuthoringItem(ctx, { ...item, companyId });
		const first = firstItem._id,
			second = secondItem._id,
			foreign = foreignItem._id;
		const choices = { [first]: 'preferred', [second]: 'preferred' } as Record<
			Id<'playbookItems'>,
			string
		>;
		const references = [firstItem, secondItem].map((saved) => ({
			itemId: saved._id,
			revisionId: saved.currentRevisionId,
			audience: 'rep' as const
		}));
		const templateVersionId = await db.insert('templateVersions', {
			mutability: 'frozen',
			companyId,
			updatedAt: 123,
			blockCount: 1,
			itemCount: 2,
			snapshotBytes: 0,
			contentReadBytes: 0,
			headReadBytes: 0,
			structureResultBytes: 0,
			authoringGeneration: 1,
			structuralGeneration: 1,
			validation: { format: VALIDATION_CODEC_VERSION, fingerprint: integrity.fingerprint },
			items: references,
			templateSourceId
		});
		const id = await db.insert('savedContracts', {
			title: 'Synthetic Buyer',
			buyer: { kind: 'manual' },
			companyId,
			creatorId: profileId,
			templateVersionId,
			stateRevision: 7,
			metadataRevision: 7,
			concessions: [],
			review: { generation: 0 },
			savedAt: 123,
			lastOperation: { id: 'previous-operation', callerId: profileId }
		});
		const contract = await readContract(ctx, (await db.get('savedContracts', id))!);
		await writeDirectory(ctx, contract);
		return { id, first, second, foreign, choices };
	});
	if (selected)
		await t.mutation(api.contracts.save, {
			membershipId,
			id: ids.id,
			selections: ids.choices,
			expectedStateRevision: 7,
			operationId: fixtureOperationId('fixture-selection')
		});
	return { t, membershipId, ...ids };
}

async function persisted(t: Awaited<ReturnType<typeof fixture>>['t'], id: SaveArgs['id']) {
	return t.run(async (ctx) => {
		const root = await ctx.db.get('savedContracts', id);
		return root ? readContract(ctx, root) : null;
	});
}

type SaveArgs = FunctionArgs<typeof api.contracts.save>;
const handler = (
	save as unknown as {
		_handler: (
			ctx: MutationCtx,
			args: SaveArgs
		) => Promise<FunctionReturnType<typeof api.contracts.save>>;
	}
)._handler;
function observeSave(t: Awaited<ReturnType<typeof fixture>>['t'], args: SaveArgs) {
	const counts = {
		snapshotItems: 0,
		snapshotBlocks: 0,
		writes: 0,
		receiptWrites: 0,
		directoryWrites: 0,
		rootWrites: 0
	};
	const result = t.run((ctx) => {
		const db = new Proxy(ctx.db, {
			get(target, key, receiver) {
				if (key === 'query')
					return (table: Parameters<MutationCtx['db']['query']>[0]) => {
						if (table === 'templateSourceChunks') counts.snapshotBlocks++;
						return target.query(table);
					};
				const value = Reflect.get(target, key, receiver);
				if (typeof value !== 'function') return value;
				return (...values: unknown[]) => {
					if (key === 'get' && values[0] === 'playbookItemRevisions') counts.snapshotItems++;
					if (['insert', 'patch', 'replace', 'delete'].includes(String(key))) {
						if (values[0] === 'savedContracts') counts.rootWrites++;
						else if (values[0] === 'contractDirectory') counts.directoryWrites++;
						else if (values[0] === 'operationReceipts') counts.receiptWrites++;
						else counts.writes++;
					}
					return value.apply(target, values);
				};
			}
		});
		return handler({ ...ctx, db }, jsonToConvex(convexToJson(args)) as SaveArgs);
	});
	return { result, counts };
}

describe('saving work', () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('acknowledges no-ops and replays without work, but rejects stale competing saves', async () => {
		const { t, id, choices, membershipId } = await fixture(true);
		const before = await persisted(t, id);
		const beforeState = await t.query(api.contracts.state, { id });
		if (!beforeState) throw new Error('Fixture state missing');
		const args = {
			membershipId,
			id,
			selections: choices,
			expectedStateRevision: beforeState.stateRevision,
			operationId: fixtureOperationId('unchanged-operation')
		};
		const { result, counts } = observeSave(t, args);
		const {
			_id,
			_creationTime,
			companyId,
			creatorId,
			templateVersionId,
			savedAt,
			buyerName,
			requestDelivery,
			buyerLink,
			hasUnreadComment,
			latestQuote,
			workBlock,
			...state
		} = beforeState;
		expect(await result).toEqual({ status: 'saved', state });
		expect(counts).toEqual({
			snapshotItems: 0,
			snapshotBlocks: 0,
			writes: 0,
			receiptWrites: 0,
			directoryWrites: 0,
			rootWrites: 0
		});
		expect(CompiledDocument).not.toHaveBeenCalled();
		expect(await t.mutation(api.contracts.save, args)).toEqual(await result);
		expect(await persisted(t, id)).toEqual(before);

		const changed = {
			membershipId,
			id,
			selections: {},
			expectedStateRevision: beforeState.stateRevision,
			operationId: fixtureOperationId('intervening-operation')
		};
		const saved = await t.mutation(api.contracts.save, changed);
		const persistedAfterSave = await persisted(t, id);
		const replay = observeSave(t, changed);
		expect(await replay.result).toEqual(saved);
		expect(replay.counts).toEqual(counts);
		expect(await t.mutation(api.contracts.save, changed)).toEqual(saved);
		expect(
			await t.mutation(api.contracts.save, {
				...changed,
				operationId: fixtureOperationId('stale')
			})
		).toMatchObject({
			status: 'conflict',
			state: { stateRevision: beforeState.stateRevision + 1 }
		});
		expect(await persisted(t, id)).toEqual(persistedAfterSave);
	});

	it('saves two, zero and one selections without frozen-source reads or compilation', async () => {
		const { t, id, first, choices, membershipId } = await fixture();
		for (const [index, selected] of [
			choices,
			{} as Record<Id<'playbookItems'>, string>,
			{ [first]: 'preferred' } as Record<Id<'playbookItems'>, string>
		].entries()) {
			const operationId = fixtureOperationId(`changed-operation-${index}`);
			const expectedReads = Object.keys(selected).length;
			const { result, counts } = observeSave(t, {
				membershipId,
				id,
				selections: selected,
				expectedStateRevision: 7 + index,
				operationId
			});
			const saved = await result;
			expect(saved).toMatchObject({
				status: 'saved',
				state: { stateRevision: 8 + index, lastOperationId: operationId }
			});
			if (saved.status !== 'saved') throw new Error('Save failed');
			expect(concessionSelectionMap(saved.state.concessions)).toEqual(selected);
			expect(saved.state.concessions.every((entry) => entry.status === 'approved')).toBe(true);
			expect(counts).toEqual({
				snapshotItems: expectedReads,
				snapshotBlocks: 0,
				writes: 0,
				receiptWrites: 1,
				directoryWrites: 1,
				rootWrites: 1
			});
			expect(CompiledDocument).not.toHaveBeenCalled();
			const stored = await persisted(t, id);
			expect(stored?.root).toMatchObject({
				stateRevision: 8 + index,
				lastOperation: { id: operationId }
			});
			expect(stored!.root.savedAt).toBeGreaterThan(123);
		}
	});

	it('public saves reject foreign items and invalid concessions without changing state', async () => {
		const { t, id, first, foreign, membershipId } = await fixture();
		const before = await persisted(t, id);
		for (const selections of [
			{ [foreign]: 'preferred' } as Record<Id<'playbookItems'>, string>,
			{ [first]: 'invalid' } as Record<Id<'playbookItems'>, string>
		]) {
			await expect(
				t.mutation(api.contracts.save, {
					membershipId,
					id,
					selections,
					expectedStateRevision: 7,
					operationId: fixtureOperationId('invalid-choice')
				})
			).rejects.toThrow('This Playbook option is unavailable.');
		}
		expect(CompiledDocument).not.toHaveBeenCalled();
		expect(await persisted(t, id)).toEqual(before);
	});

	it('still validates operations and rejects obsolete save fields on unchanged saves and handles missing contracts', async () => {
		const { t, id, membershipId } = await fixture();
		const args = {
			membershipId,
			id,
			selections: {},
			expectedStateRevision: 7,
			operationId: fixtureOperationId('noop')
		};
		for (const operationId of ['', '   ', 'x'.repeat(201)])
			await expect(t.mutation(api.contracts.save, { ...args, operationId })).rejects.toThrow(
				'Invalid operation identity.'
			);
		await expect(
			t.mutation(api.contracts.save, { ...args, expectedEditRevision: -1 } as never)
		).rejects.toThrow('Unexpected field `expectedEditRevision`');
		await t.run(async ({ db }) => {
			await db.delete('savedContracts', id);
		});
		expect(await t.mutation(api.contracts.save, args)).toEqual({ status: 'deleted' });
	});
});
