// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/convex/_generated/api';
import type { MutationCtx } from '../../src/convex/_generated/server';
import schema from '../../src/convex/schema';
import { canonicalBaselineFingerprint } from '../../src/convex/baselineStorage';
import { storeItemRevision } from '../../src/convex/playbookItemRevisions';
import { saveChoices } from '../../src/convex/savedContracts';
import { writeDirectory } from '../../src/convex/contractDirectory';
import { CompiledContract } from '../../src/lib/contract/compiled-contract';
import { block, item, identity, initializeViewer } from './fixtures';

// Spy at the real compiler boundary, retaining its implementation.
vi.mock('../../src/lib/contract/compiled-contract', { spy: true });
const modules = import.meta.glob('../../src/convex/**/*.*s');

async function fixture(selected = false) {
	const t = convexTest(schema, modules).withIdentity(identity);
	const { profileId, companyId, membershipId } = await t.run(initializeViewer);
	const ids = await t.run(async (ctx) => {
		const { db } = ctx;
		await db.patch('company', companyId, { contractDirectoryReady: true });
		const baselineId = await db.insert('baselines', {
			companyId,
			state: 'published',
			source: 'seed',
			fingerprint: canonicalBaselineFingerprint([block]),
			issues: [],
			blockCount: 1
		});
		const first = await db.insert('playbookItems', { ...item, companyId, revision: 1 });
		const second = await db.insert('playbookItems', { ...item, companyId, revision: 1 });
		const foreign = await db.insert('playbookItems', { ...item, companyId, revision: 1 });
		const choices = { [first]: 'preferred', [second]: 'preferred' };
		const versionId = await db.insert('templateVersions', {
			companyId,
			publishedAt: 123,
			blockCount: 1,
			itemCount: 2,
			snapshotBytes: 0,
			baselineId
		});
		const id = await db.insert('savedContracts', {
			companyName: 'Synthetic Buyer',
			companyId,
			creatorId: profileId,
			templateVersionId: versionId,
			savedAt: 123,
			revision: 7,
			lastOperationId: 'previous-operation',
			reviews: {},
			selectedConcessions: selected ? choices : {}
		});
		await db.insert('contractBlocks', { companyId, baselineId, ...block });
		await writeDirectory(ctx, (await db.get('savedContracts', id))!);
		for (const itemId of [first, second]) {
			const document = (await db.get('playbookItems', itemId))!;
			await db.insert('templateVersionItems', {
				companyId,
				versionId,
				itemId,
				revisionId: await storeItemRevision(ctx, document)
			});
		}
		return { id, first, second, foreign, choices };
	});
	return { t, membershipId, ...ids };
}

type SaveArgs = FunctionArgs<typeof api.savedContracts.saveChoices>;
// Convex retains the handler at runtime; its public RegisteredMutation type hides it.
const handler = (
	saveChoices as unknown as {
		_handler: (
			ctx: MutationCtx,
			args: SaveArgs
		) => Promise<FunctionReturnType<typeof api.savedContracts.saveChoices>>;
	}
)._handler;
function observeSave(t: Awaited<ReturnType<typeof fixture>>['t'], args: SaveArgs) {
	const counts = { snapshotItems: 0, snapshotBlocks: 0, writes: 0, directoryWrites: 0 };
	const result = t.run((ctx) => {
		// Delegate every operation to convex-test; only count this handler's DB calls.
		const db = new Proxy(ctx.db, {
			get(target, key, receiver) {
				if (key === 'query')
					return (table: Parameters<MutationCtx['db']['query']>[0]) => {
						if (table === 'templateVersionItems') counts.snapshotItems++;
						if (table === 'contractBlocks') counts.snapshotBlocks++;
						return target.query(table);
					};
				const value = Reflect.get(target, key, receiver);
				if (typeof value !== 'function') return value;
				return (...values: unknown[]) => {
					if (['insert', 'patch', 'replace', 'delete'].includes(String(key))) {
						if (values[0] === 'contractDirectory') counts.directoryWrites++;
						else counts.writes++;
					}
					return value.apply(target, values);
				};
			}
		});
		return handler({ ...ctx, db }, args);
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
			selectedConcessions: { [second]: 'preferred', [first]: 'preferred' },
			selectionLifecycles: {},
			expectedRevision: 7,
			operationId: 'unchanged-operation'
		};
		const { result, counts } = observeSave(t, args);
		expect(await result).toEqual({
			status: 'saved',
			state: {
				companyName: 'Synthetic Buyer',
				selectedConcessions: choices,
				reviews: {},
				revision: 7,
				lastOperationId: 'previous-operation'
			}
		});
		expect(counts).toEqual({ snapshotItems: 0, snapshotBlocks: 0, writes: 0, directoryWrites: 0 });
		expect(CompiledContract).not.toHaveBeenCalled();
		// Public call and retry preserve the whole persisted document, including savedAt.
		expect(await t.mutation(api.savedContracts.saveChoices, args)).toEqual(await result);
		expect(await t.run(({ db }) => db.get('savedContracts', id))).toEqual(before);
		await t.mutation(api.savedContracts.saveChoices, {
			...args,
			selectedConcessions: {},
			operationId: 'intervening-operation'
		});
		expect(await t.mutation(api.savedContracts.saveChoices, args)).toMatchObject({
			status: 'conflict',
			state: { revision: 8, lastOperationId: 'intervening-operation' }
		});
	});

	it.each([0, 1])(
		'changed %i-selection saves skip baseline reads and compilation',
		async (size) => {
			const { t, id, first, membershipId } = await fixture(size === 0);
			const selectedConcessions = size ? { [first]: 'preferred' } : {};
			const { result, counts } = observeSave(t, {
				membershipId,
				id,
				selectedConcessions,
				selectionLifecycles: {},
				expectedRevision: 7,
				operationId: 'changed-operation'
			});
			expect(await result).toMatchObject({
				status: 'saved',
				state: {
					selectedConcessions,
					revision: 8,
					lastOperationId: 'changed-operation'
				}
			});
			expect(counts).toEqual({
				snapshotItems: size,
				snapshotBlocks: 0,
				writes: 1,
				directoryWrites: 1
			});
			expect(CompiledContract).not.toHaveBeenCalled();
			const stored = await t.run(({ db }) => db.get('savedContracts', id));
			expect(stored).toMatchObject({
				selectedConcessions,
				revision: 8,
				lastOperationId: 'changed-operation'
			});
			expect(stored!.savedAt).toBeGreaterThan(123);
		}
	);

	it('observes baseline reads and real compilation for a changed two-selection save', async () => {
		const { t, id, choices, membershipId } = await fixture();
		const { result, counts } = observeSave(t, {
			membershipId,
			id,
			selectedConcessions: choices,
			selectionLifecycles: {},
			expectedRevision: 7,
			operationId: 'two-choices'
		});
		expect(await result).toMatchObject({ status: 'saved', state: { revision: 8 } });
		expect(counts).toEqual({ snapshotItems: 2, snapshotBlocks: 1, writes: 1, directoryWrites: 1 });
		expect(CompiledContract).toHaveBeenCalledTimes(1);
	});

	it('public saves reject foreign items and invalid concessions without changing state', async () => {
		const { t, id, first, foreign, membershipId } = await fixture();
		const before = await t.run(({ db }) => db.get('savedContracts', id));
		for (const selectedConcessions of [{ [foreign]: 'preferred' }, { [first]: 'invalid' }]) {
			await expect(
				t.mutation(api.savedContracts.saveChoices, {
					membershipId,
					id,
					selectedConcessions,
					selectionLifecycles: {},
					expectedRevision: 7,
					operationId: 'invalid-choice'
				})
			).rejects.toThrow('A selected concession does not belong to this contract.');
		}
		expect(CompiledContract).not.toHaveBeenCalled();
		expect(await t.run(({ db }) => db.get('savedContracts', id))).toEqual(before);
	});

	it('acknowledges replays before stale revision checks, and conflicts on other stale saves', async () => {
		const { t, id, first, membershipId } = await fixture();
		const args = {
			membershipId,
			id,
			selectedConcessions: { [first]: 'preferred' },
			selectionLifecycles: {},
			expectedRevision: 7,
			operationId: 'save'
		};
		const saved = await t.mutation(api.savedContracts.saveChoices, args);
		const before = await t.run(({ db }) => db.get('savedContracts', id));
		const replay = observeSave(t, args);
		expect(await replay.result).toEqual(saved);
		expect(replay.counts).toEqual({
			snapshotItems: 0,
			snapshotBlocks: 0,
			writes: 0,
			directoryWrites: 0
		});
		expect(await t.mutation(api.savedContracts.saveChoices, args)).toEqual(saved);
		expect(
			await t.mutation(api.savedContracts.saveChoices, { ...args, operationId: 'stale' })
		).toMatchObject({ status: 'conflict', state: { revision: 8 } });
		expect(await t.run(({ db }) => db.get('savedContracts', id))).toEqual(before);
	});

	it('still validates operations and revisions on unchanged saves and handles missing contracts', async () => {
		const { t, id, membershipId } = await fixture();
		const args = {
			membershipId,
			id,
			selectedConcessions: {},
			selectionLifecycles: {},
			expectedRevision: 7,
			operationId: 'noop'
		};
		for (const operationId of ['', '   ', 'x'.repeat(201)])
			await expect(
				t.mutation(api.savedContracts.saveChoices, { ...args, operationId })
			).rejects.toThrow('Invalid save operation.');
		for (const expectedRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
			await expect(
				t.mutation(api.savedContracts.saveChoices, { ...args, expectedRevision })
			).rejects.toThrow('Invalid contract revision.');
		await t.run(async ({ db }) => {
			await db.delete('savedContracts', id);
		});
		expect(await t.mutation(api.savedContracts.saveChoices, args)).toEqual({ status: 'deleted' });
	});
});
