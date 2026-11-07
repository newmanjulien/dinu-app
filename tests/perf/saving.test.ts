// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { convexToJson, jsonToConvex } from 'convex/values';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/convex/_generated/api';
import type { MutationCtx } from '../../src/convex/_generated/server';
import { baselineIntegrity, writeBaselineChunks } from '../../src/convex/baselineStorage';
import { writeDirectory } from '../../src/convex/contractDirectory';
import { saveChoices } from '../../src/convex/contracts';
import { storeItemRevision } from '../../src/convex/playbookItemRevisions';
import schema from '../../src/convex/schema';
import { CompiledContract } from '../../src/lib/contract/compiled-contract';
import { block, choicesFor, commandsFor, identity, initializeViewer, item } from './fixtures';

// Spy at the real compiler boundary, retaining its implementation.
vi.mock('../../src/lib/contract/compiled-contract', { spy: true });
const modules = import.meta.glob('../../src/convex/**/*.*s');

async function fixture(selected = false) {
	const t = convexTest(schema, modules).withIdentity(identity);
	const { profileId, companyId, membershipId } = await t.run(initializeViewer);
	const ids = await t.run(async (ctx) => {
		const { db } = ctx;
		const baselineId = await db.insert('baselines', {
			companyId,
			state: 'active',
			source: 'seed',
			...baselineIntegrity([block]),
			issues: [],
			blockCount: 1,
			bootstrapKey: 'a'.repeat(64),
			activatedAt: 123,
			chunkCount: 0,
			chunkReadBytes: 0
		});
		await db.patch(
			'baselines',
			baselineId,
			await writeBaselineChunks(ctx, { companyId, baselineId, blocks: [block] })
		);
		await db.patch('company', companyId, { baselineId });
		const first = await db.insert('playbookItems', { ...item, companyId, contentRevision: 1 });
		const second = await db.insert('playbookItems', { ...item, companyId, contentRevision: 1 });
		const foreign = await db.insert('playbookItems', { ...item, companyId, contentRevision: 1 });
		const choices = { [first]: 'preferred', [second]: 'preferred' };
		const references = [];
		for (const itemId of [first, second]) {
			const document = (await db.get('playbookItems', itemId))!;
			if ('format' in document) throw new Error('Fixture expected a legacy business row');
			references.push({ itemId, revisionId: await storeItemRevision(ctx, document) });
		}
		const versionId = await db.insert('templateVersions', {
			mutability: 'frozen',
			companyId,
			updatedAt: 123,
			blockCount: 1,
			itemCount: 2,
			snapshotBytes: 0,
			contentReadBytes: 0,
			items: references,
			baselineId
		});
		const id = await db.insert('savedContracts', {
			stateVersion: 1,
			buyerCompanyName: 'Synthetic Buyer',
			companyId,
			creatorId: profileId,
			templateVersionId: versionId,
			savedAt: 123,
			editRevision: 7,
			reviewGeneration: 0,
			lastOperation: { id: 'previous-operation', callerId: profileId },
			applications: selected ? choicesFor(choices) : {}
		});
		await writeDirectory(ctx, (await db.get('savedContracts', id))!);
		return { id, first, second, foreign, choices };
	});
	return { t, membershipId, ...ids };
}

type SaveArgs = FunctionArgs<typeof api.contracts.saveChoices>;
// Convex retains the handler at runtime; its public RegisteredMutation type hides it.
const handler = (
	saveChoices as unknown as {
		_handler: (
			ctx: MutationCtx,
			args: SaveArgs
		) => Promise<FunctionReturnType<typeof api.contracts.saveChoices>>;
	}
)._handler;
function observeSave(t: Awaited<ReturnType<typeof fixture>>['t'], args: SaveArgs) {
	const counts = {
		snapshotItems: 0,
		snapshotBlocks: 0,
		writes: 0,
		receiptWrites: 0,
		directoryWrites: 0
	};
	const result = t.run((ctx) => {
		// Delegate every operation to convex-test; only count this handler's DB calls.
		const db = new Proxy(ctx.db, {
			get(target, key, receiver) {
				if (key === 'query')
					return (table: Parameters<MutationCtx['db']['query']>[0]) => {
						if (table === 'baselineChunks') counts.snapshotBlocks++;
						return target.query(table);
					};
				const value = Reflect.get(target, key, receiver);
				if (typeof value !== 'function') return value;
				return (...values: unknown[]) => {
					if (key === 'get' && values[0] === 'playbookItemRevisions') counts.snapshotItems++;
					if (['insert', 'patch', 'replace', 'delete'].includes(String(key))) {
						if (values[0] === 'contractDirectory') counts.directoryWrites++;
						else if (values[0] === 'hubspotReceipts' || values[0] === 'hubspotReceiptChunks')
							counts.receiptWrites++;
						else counts.writes++;
					}
					return value.apply(target, values);
				};
			}
		});
		// Match Convex’s wire normalization while observing the real handler.
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

	it('acknowledges identical selections without snapshot reads, compilation or writes', async () => {
		const { t, id, first, second, choices, membershipId } = await fixture(true);
		const before = await t.run(({ db }) => db.get('savedContracts', id));
		const args = {
			membershipId,
			id,
			choices: choicesFor({ [second]: 'preferred', [first]: 'preferred' }),
			expectedEditRevision: 7,
			operationId: 'unchanged-operation',
			commands: []
		};
		const { result, counts } = observeSave(t, args);
		expect(await result).toEqual({
			status: 'saved',
			state: {
				buyerCompanyName: 'Synthetic Buyer',
				applications: choicesFor(choices),
				editRevision: 7,
				reviewGeneration: 0,
				reviewCompletion: null,
				stateVersion: 1,
				lastOperationId: 'previous-operation'
			}
		});
		expect(counts).toEqual({
			snapshotItems: 0,
			snapshotBlocks: 0,
			writes: 0,
			receiptWrites: 0,
			directoryWrites: 0
		});
		expect(CompiledContract).not.toHaveBeenCalled();
		// Public call and retry preserve the whole persisted document, including savedAt.
		expect(await t.mutation(api.contracts.saveChoices, args)).toEqual(await result);
		expect(await t.run(({ db }) => db.get('savedContracts', id))).toEqual(before);
		await t.mutation(api.contracts.saveChoices, {
			...args,
			choices: {},
			operationId: 'intervening-operation',
			commands: commandsFor(choicesFor(choices), {}, 'intervening-operation')
		});
		expect(await t.mutation(api.contracts.saveChoices, args)).toMatchObject({
			status: 'conflict',
			state: { editRevision: 8, lastOperationId: 'intervening-operation' }
		});
	});

	it.each([0, 1])(
		'changed %i-selection saves skip baseline reads and compilation',
		async (size) => {
			const { t, id, first, choices, membershipId } = await fixture(size === 0);
			const selectedConcessions = size ? { [first]: 'preferred' } : {};
			const { result, counts } = observeSave(t, {
				membershipId,
				id,
				choices: choicesFor(selectedConcessions),
				expectedEditRevision: 7,
				operationId: 'changed-operation',
				commands: commandsFor(
					size === 0 ? choicesFor(choices) : {},
					choicesFor(selectedConcessions),
					'changed-operation'
				)
			});
			expect(await result).toMatchObject({
				status: 'saved',
				state: {
					applications: choicesFor(selectedConcessions),
					editRevision: 8,
					lastOperationId: 'changed-operation'
				}
			});
			expect(counts).toEqual({
				snapshotItems: size,
				snapshotBlocks: 0,
				writes: 1,
				receiptWrites: size === 0 ? 3 : 2,
				directoryWrites: 1
			});
			expect(CompiledContract).not.toHaveBeenCalled();
			const stored = await t.run(({ db }) => db.get('savedContracts', id));
			expect(stored).toMatchObject({
				applications: choicesFor(selectedConcessions),
				editRevision: 8,
				lastOperation: { id: 'changed-operation' }
			});
			expect(stored!.savedAt).toBeGreaterThan(123);
		}
	);

	it('observes baseline reads and real compilation for a changed two-selection save', async () => {
		const { t, id, choices, membershipId } = await fixture();
		const { result, counts } = observeSave(t, {
			membershipId,
			id,
			choices: choicesFor(choices),
			expectedEditRevision: 7,
			operationId: 'two-choices',
			commands: commandsFor({}, choicesFor(choices), 'two-choices')
		});
		expect(await result).toMatchObject({ status: 'saved', state: { editRevision: 8 } });
		expect(counts).toEqual({
			snapshotItems: 2,
			snapshotBlocks: 1,
			writes: 1,
			receiptWrites: 3,
			directoryWrites: 1
		});
		expect(CompiledContract).toHaveBeenCalledTimes(1);
	});

	it('public saves reject foreign items and invalid concessions without changing state', async () => {
		const { t, id, first, foreign, membershipId } = await fixture();
		const before = await t.run(({ db }) => db.get('savedContracts', id));
		for (const selectedConcessions of [{ [foreign]: 'preferred' }, { [first]: 'invalid' }]) {
			await expect(
				t.mutation(api.contracts.saveChoices, {
					membershipId,
					id,
					choices: choicesFor(selectedConcessions),
					expectedEditRevision: 7,
					operationId: 'invalid-choice',
					commands: commandsFor({}, choicesFor(selectedConcessions), 'invalid-choice')
				})
			).rejects.toThrow('A selected concession does not belong to this contract.');
		}
		expect(CompiledContract).not.toHaveBeenCalled();
		expect(await t.run(({ db }) => db.get('savedContracts', id))).toEqual(before);
	});

	it('acknowledges replays before stale editRevision checks, and conflicts on other stale saves', async () => {
		const { t, id, first, membershipId } = await fixture();
		const args = {
			membershipId,
			id,
			choices: choicesFor({ [first]: 'preferred' }),
			expectedEditRevision: 7,
			operationId: 'save',
			commands: commandsFor({}, choicesFor({ [first]: 'preferred' }), 'save')
		};
		const saved = await t.mutation(api.contracts.saveChoices, args);
		const before = await t.run(({ db }) => db.get('savedContracts', id));
		const replay = observeSave(t, args);
		expect(await replay.result).toEqual(saved);
		expect(replay.counts).toEqual({
			snapshotItems: 0,
			snapshotBlocks: 0,
			writes: 0,
			receiptWrites: 0,
			directoryWrites: 0
		});
		expect(await t.mutation(api.contracts.saveChoices, args)).toEqual(saved);
		expect(
			await t.mutation(api.contracts.saveChoices, { ...args, operationId: 'stale' })
		).toMatchObject({ status: 'conflict', state: { editRevision: 8 } });
		expect(await t.run(({ db }) => db.get('savedContracts', id))).toEqual(before);
	});

	it('still validates operations and revisions on unchanged saves and handles missing contracts', async () => {
		const { t, id, membershipId } = await fixture();
		const args = {
			membershipId,
			id,
			choices: {},
			expectedEditRevision: 7,
			operationId: 'noop',
			commands: []
		};
		for (const operationId of ['', '   ', 'x'.repeat(201)])
			await expect(t.mutation(api.contracts.saveChoices, { ...args, operationId })).rejects.toThrow(
				'Invalid save operation.'
			);
		for (const expectedEditRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
			await expect(
				t.mutation(api.contracts.saveChoices, { ...args, expectedEditRevision })
			).rejects.toThrow('Invalid contract revision.');
		await t.run(async ({ db }) => {
			await db.delete('savedContracts', id);
		});
		expect(await t.mutation(api.contracts.saveChoices, args)).toEqual({ status: 'deleted' });
	});
});
