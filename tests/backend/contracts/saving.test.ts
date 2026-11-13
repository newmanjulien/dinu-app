// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { convexToJson, jsonToConvex } from 'convex/values';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../src/convex/_generated/api';
import type { MutationCtx } from '../../../src/convex/_generated/server';
import {
	templateSourceIntegrity,
	writeTemplateSourceChunks
} from '../../../src/convex/templateSourceStorage';
import { writeDirectory } from '../../../src/convex/contractDirectory';
import { readContract } from '../../../src/convex/contractState';
import { saveChanges } from '../../../src/convex/contracts';
import { storeItemRevision } from '../../../src/convex/playbookItemRevisions';
import { writeContractDocument } from '../../../src/convex/contractDocuments';
import { createContractDocument } from '../../../src/lib/document/contract-document';
import schema from '../../../src/convex/schema';
import { CompiledDocument } from '../../../src/lib/document/compiled-document';
import { block, commandsFor, identity, initializeViewer, item } from '../../support/contract-data';

// Spy at the real compiler boundary, retaining its implementation.
vi.mock('../../../src/lib/document/compiled-document', { spy: true });
const modules = import.meta.glob('../../../src/convex/**/*.*s');

async function fixture(selected = false) {
	const t = convexTest(schema, modules).withIdentity(identity);
	const { profileId, companyId, membershipId } = await t.run(initializeViewer);
	const ids = await t.run(async (ctx) => {
		const { db } = ctx;
		const templateSourceId = await db.insert('templateSources', {
			companyId,
			state: 'active',
			source: 'seed',
			...templateSourceIntegrity([block]),
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
		await db.patch('company', companyId, { templateSourceId });
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
		const templateVersionId = await db.insert('templateVersions', {
			mutability: 'frozen',
			companyId,
			updatedAt: 123,
			blockCount: 1,
			itemCount: 2,
			snapshotBytes: 0,
			contentReadBytes: 0,
			items: references,
			templateSourceId
		});
		const id = await db.insert('savedContracts', {
			title: 'Synthetic Buyer',
			buyer: { kind: 'manual' },
			companyId,
			creatorId: profileId,
			templateVersionId,
			documentId: null,
			documentRevision: 0,
			stateRevision: 7,
			playbookSelectionCount: 0,
			playbookReviewCount: 0,
			playbookPendingCount: 0,
			playbookDeclinedCount: 0,
			playbookReviewIdentity: 'initial-playbook',
			buyerLinkReviewIdentity: 'initial-buyer-link',
			savedAt: 123,
			lastOperation: { id: 'previous-operation', callerId: profileId }
		});
		const documentId = await writeContractDocument(ctx, {
			companyId,
			contractId: id,
			document: createContractDocument([block])
		});
		await db.patch('savedContracts', id, { documentId });
		const contract = await readContract(ctx, (await db.get('savedContracts', id))!);
		await writeDirectory(ctx, contract);
		return { id, first, second, foreign, choices };
	});
	if (selected)
		await t.mutation(api.contracts.saveChanges, {
			membershipId,
			id: ids.id,
			operationId: 'fixture-selection',
			commands: commandsFor([], ids.choices, 'fixture-selection')
		});
	return { t, membershipId, ...ids };
}

async function persisted(t: Awaited<ReturnType<typeof fixture>>['t'], id: SaveArgs['id']) {
	return t.run(async (ctx) => {
		const root = await ctx.db.get('savedContracts', id);
		return root ? readContract(ctx, root) : null;
	});
}

type SaveArgs = FunctionArgs<typeof api.contracts.saveChanges>;
// Convex retains the handler at runtime; its public RegisteredMutation type hides it.
const handler = (
	saveChanges as unknown as {
		_handler: (
			ctx: MutationCtx,
			args: SaveArgs
		) => Promise<FunctionReturnType<typeof api.contracts.saveChanges>>;
	}
)._handler;
function observeSave(t: Awaited<ReturnType<typeof fixture>>['t'], args: SaveArgs) {
	const counts = {
		snapshotItems: 0,
		snapshotBlocks: 0,
		writes: 0,
		receiptWrites: 0,
		directoryWrites: 0,
		rootWrites: 0,
		changeWrites: 0,
		documentWrites: 0
	};
	const result = t.run((ctx) => {
		// Delegate every operation to convex-test; only count this handler's DB calls.
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
						if (values[0] === 'contractDocuments' || values[0] === 'contractDocumentChunks')
							counts.documentWrites++;
						else if (
							[
								'contractChanges',
								'contractChangeContents',
								'contractChangeHeads',
								'contractChangeDecisions'
							].includes(String(values[0]))
						)
							counts.changeWrites++;
						else if (values[0] === 'savedContracts') counts.rootWrites++;
						else if (values[0] === 'contractDirectory') counts.directoryWrites++;
						else if (values[0] === 'operationReceipts' || values[0] === 'operationReceiptChunks')
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

	it('acknowledges no-ops and replays without work, but rejects stale competing saves', async () => {
		const { t, id, choices, membershipId } = await fixture(true);
		const before = await persisted(t, id);
		const args = {
			membershipId,
			id,
			operationId: 'unchanged-operation',
			commands: []
		};
		const { result, counts } = observeSave(t, args);
		const beforeState = await t.query(api.contracts.state, { membershipId, id });
		if (!beforeState) throw new Error('Fixture state missing');
		const {
			_id,
			_creationTime,
			companyId,
			creatorId,
			templateVersionId,
			savedAt,
			buyerName,
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
			rootWrites: 0,
			changeWrites: 0,
			documentWrites: 0
		});
		expect(CompiledDocument).not.toHaveBeenCalled();
		// Public call and retry preserve the whole persisted document, including savedAt.
		expect(await t.mutation(api.contracts.saveChanges, args)).toEqual(await result);
		expect(await persisted(t, id)).toEqual(before);
		const changed = {
			...args,
			operationId: 'intervening-operation',
			commands: commandsFor(beforeState.playbook, {}, 'intervening-operation')
		};
		const saved = await t.mutation(api.contracts.saveChanges, changed);
		const persistedAfterSave = await persisted(t, id);
		const replay = observeSave(t, changed);
		expect(await replay.result).toEqual(saved);
		expect(replay.counts).toEqual(counts);
		expect(await t.mutation(api.contracts.saveChanges, changed)).toEqual(saved);
		expect(
			await t.mutation(api.contracts.saveChanges, { ...changed, operationId: 'stale' })
		).toMatchObject({
			status: 'conflict',
			state: { stateRevision: beforeState.stateRevision + 1 }
		});
		expect(await persisted(t, id)).toEqual(persistedAfterSave);
		expect(await t.mutation(api.contracts.saveChanges, args)).toMatchObject({
			status: 'saved',
			state: {
				stateRevision: beforeState.stateRevision + 1,
				playbook: expect.arrayContaining(
					beforeState.playbook.map((head) =>
						expect.objectContaining({
							itemId: head.itemId,
							currentOptionId: null,
							appliedOptionId: null
						})
					)
				),
				lastOperationId: 'intervening-operation'
			}
		});
	});

	it('saves two, zero and one selections without frozen-source reads or compilation', async () => {
		const { t, id, first, choices, membershipId } = await fixture();
		let previous: import('../../../src/lib/contract/changes').PlaybookState[] = [];
		for (const [index, selected] of [choices, {}, { [first]: 'preferred' }].entries()) {
			const options = selected;
			const operationId = `changed-operation-${index}`;
			const changedItems = index === 2 ? 1 : 2;
			const { result, counts } = observeSave(t, {
				membershipId,
				id,
				operationId,
				commands: commandsFor(previous, options, operationId)
			});
			const saved = await result;
			expect(saved).toMatchObject({
				status: 'saved',
				state: { stateRevision: 8 + index, lastOperationId: operationId }
			});
			if (saved.status !== 'saved') throw new Error('Save failed');
			expect(
				Object.fromEntries(
					saved.state.playbook
						.filter((head) => head.currentOptionId !== null)
						.map((head) => [head.itemId, head.currentOptionId])
				)
			).toEqual(options);
			expect(
				saved.state.playbook.every(
					(head) => head.currentChangeId === head.appliedChangeId && head.status === 'approved'
				)
			).toBe(true);
			expect(counts).toEqual({
				snapshotItems: changedItems,
				snapshotBlocks: 0,
				writes: 0,
				receiptWrites: changedItems + 1,
				directoryWrites: 1,
				rootWrites: 1,
				changeWrites: changedItems * 3,
				documentWrites: 0
			});
			expect(CompiledDocument).not.toHaveBeenCalled();
			const stored = await persisted(t, id);
			expect(stored?.root).toMatchObject({
				stateRevision: 8 + index,
				lastOperation: { id: operationId }
			});
			expect(stored!.root.savedAt).toBeGreaterThan(123);
			previous = saved.state.playbook;
		}
	});

	it('public saves reject foreign items and invalid concessions without changing state', async () => {
		const { t, id, first, foreign, membershipId } = await fixture();
		const before = await persisted(t, id);
		for (const selectedConcessions of [{ [foreign]: 'preferred' }, { [first]: 'invalid' }]) {
			await expect(
				t.mutation(api.contracts.saveChanges, {
					membershipId,
					id,
					operationId: 'invalid-choice',
					commands: commandsFor([], selectedConcessions, 'invalid-choice')
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
			operationId: 'noop',
			commands: []
		};
		for (const operationId of ['', '   ', 'x'.repeat(201)])
			await expect(t.mutation(api.contracts.saveChanges, { ...args, operationId })).rejects.toThrow(
				'Invalid save operation.'
			);
		await expect(
			t.mutation(api.contracts.saveChanges, { ...args, expectedEditRevision: -1 } as never)
		).rejects.toThrow('Unexpected field `expectedEditRevision`');
		await t.run(async ({ db }) => {
			await db.delete('savedContracts', id);
		});
		expect(await t.mutation(api.contracts.saveChanges, args)).toEqual({ status: 'deleted' });
	});
});
