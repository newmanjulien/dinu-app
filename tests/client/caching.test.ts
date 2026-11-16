import {
	contractDocumentToRenderTransport,
	createContractDocument
} from '../../src/lib/document/contract-document';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/convex/_generated/api';
import type { Id } from '../../src/convex/_generated/dataModel';
import { createCacheScope } from '../../src/lib/contract/browser-storage';
import type { SnapshotClient } from '../../src/lib/contract/snapshot-cache';
import {
	getContractSnapshotCache,
	releaseContractSnapshotCache,
	replaceContractCacheScope
} from '../../src/lib/contract/snapshot-cache';
import type { ReadyContract } from '../../src/lib/contract/saved';
import { block, item } from '../support/contract-data';
import { observeSnapshotStorage } from './snapshot-storage-observer';
import {
	SNAPSHOT_BYTES,
	SNAPSHOT_ENTRIES,
	SnapshotStorage
} from '../../src/lib/contract/snapshot-storage';

const id = 'synthetic-contract' as Id<'savedContracts'>;
const itemId = 'synthetic-item' as Id<'playbookItems'>;
const companyId = 'synthetic-company' as Id<'company'>;
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function fixture(): ReadyContract {
	return {
		id,
		status: 'ready',
		contract: {
			_id: id,
			_creationTime: 1,
			creatorId: 'synthetic-profile' as Id<'profiles'>,
			companyId,
			templateVersionId: 'synthetic-template' as Id<'templateVersions'>,
			documentId: 'approved-document' as Id<'contractDocuments'>,
			documentRevision: 0,
			stateRevision: 0,
			title: 'Synthetic Buyer',
			savedAt: 123,
			playbook: [],
			reviews: { playbook: { identity: 'playbook:0' }, buyerLink: { identity: 'buyer-link:0' } },
			lastOperationId: null
		},
		approved: {
			documentId: 'approved-document' as Id<'contractDocuments'>,
			documentRevision: 0,
			displayIdentity: 'approved:0',
			document: contractDocumentToRenderTransport(createContractDocument([block])),
			hiddenItemIds: [],
			projectedTargets: []
		},
		snapshot: {
			blockCount: 1,
			itemCount: 1,
			blocks: [block],
			items: [
				{
					...item,
					contentRevision: 1,
					companyId,
					_id: itemId,
					_creationTime: 1
				}
			]
		}
	};
}

function networkFixture() {
	const data = fixture();
	const state = vi.fn().mockResolvedValue({ ...data.contract, lastOperationId: null });
	const version = vi.fn().mockResolvedValue(data.snapshot);
	const versionReleased = vi.fn();
	const client: SnapshotClient = {
		onUpdate: vi
			.fn<SnapshotClient['onUpdate']>()
			.mockImplementation((reference, _args, callback, onError) => {
				let subscribed = true;
				const work =
					getFunctionName(reference) === getFunctionName(api.contracts.state)
						? state()
						: getFunctionName(reference) === getFunctionName(api.contractDefinitions.current)
							? Promise.resolve(data.approved)
							: version();
				void work.then(
					(value: never) => {
						if (subscribed) callback(value);
					},
					(error: Error) => {
						if (subscribed) onError?.(error);
					}
				);
				const unsubscribe = () => {
					if (!subscribed) return;
					subscribed = false;
					if (getFunctionName(reference) === getFunctionName(api.templates.frozenContent))
						versionReleased();
				};
				return Object.assign(unsubscribe, { unsubscribe, getCurrentValue: () => undefined });
			})
	};
	return { client, state, version, versionReleased };
}

async function approvedRows() {
	const scope = createCacheScope({
		profileId: 'synthetic-profile' as Id<'profiles'>,
		membershipId: 'synthetic-membership' as Id<'memberships'>
	});
	const opening = indexedDB.open(`${scope.namespace}:snapshots`);
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		opening.onsuccess = () => resolve(opening.result);
		opening.onerror = () => reject(opening.error);
	});
	try {
		const request = db.transaction('approved', 'readonly').objectStore('approved').getAll();
		return await new Promise<{ id: string; bytes: number; data: ReadyContract['approved'] }[]>(
			(resolve, reject) => {
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			}
		);
	} finally {
		db.close();
	}
}

describe('snapshot caching work', () => {
	let storage: ReturnType<typeof observeSnapshotStorage>;

	beforeEach(() => {
		storage = observeSnapshotStorage();
		vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
		vi.stubGlobal('window', {});
		replaceContractCacheScope(
			createCacheScope({
				profileId: 'synthetic-profile' as Id<'profiles'>,
				membershipId: 'synthetic-membership' as Id<'memberships'>
			})
		);
	});

	afterEach(async () => {
		releaseContractSnapshotCache();
		vi.useRealTimers();
		try {
			await storage.close();
		} finally {
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
		}
	});

	it.each(['intent', 'navigation'] as const)(
		'respects %s lifetime when handing off background downloads',
		async (phase) => {
			// Keep IndexedDB's actual event loop; only reservation/deadline clocks are synthetic.
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const { client, state, version, versionReleased } = networkFixture();
			const started = deferred<void>();
			const response = deferred<ReadyContract['snapshot']>();
			version.mockImplementation(() => {
				started.resolve();
				return response.promise;
			});
			const cache = getContractSnapshotCache();
			cache.connect(client);
			cache.backgroundCandidates([id]);
			cache.allowBackground();
			await started.promise;
			expect(version).toHaveBeenCalledTimes(1);
			cache.reserveIntent(id);
			let finishNavigation = () => {};
			if (phase === 'navigation') {
				const finishPreviousNavigation = cache.reserveNavigation(id);
				finishNavigation = cache.reserveNavigation(id);
				finishPreviousNavigation();
				// Repeated capture must preserve the current navigation's longer lifetime.
				cache.reserveIntent(id);
			}
			cache.pauseBackground();
			await vi.advanceTimersByTimeAsync(1499);
			expect(versionReleased).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(2);
			expect(versionReleased).toHaveBeenCalledTimes(phase === 'navigation' ? 0 : 1);

			const opened = cache.load(id, client);
			finishNavigation();
			if (phase === 'navigation') expect(versionReleased).not.toHaveBeenCalled();
			const commit = storage.committedRevision(0);
			response.resolve(fixture().snapshot);
			expect(await opened).toEqual(fixture());
			await commit;
			const downloads = phase === 'navigation' ? 1 : 2;
			expect(state).toHaveBeenCalledTimes(downloads);
			expect(version).toHaveBeenCalledTimes(downloads);
			expect(versionReleased).toHaveBeenCalledTimes(downloads);
			expect(storage.immutableWrites).toBe(1);
		}
	);

	it('reopens from memory and restores initial and confirmed state from IndexedDB without another download or immutable write', async () => {
		const { client, state, version } = networkFixture();
		const initialCommit = storage.committedRevision(0);
		const first = await getContractSnapshotCache().load(id, client);
		expect(first.status).toBe('ready');
		await initialCommit;
		expect(await getContractSnapshotCache().load(id, client)).toBe(first);
		expect(state).toHaveBeenCalledTimes(1);
		expect(version).toHaveBeenCalledTimes(1);
		expect(storage.immutableWrites).toBe(1);
		releaseContractSnapshotCache();

		const cache = getContractSnapshotCache();
		const reopened = await cache.load(id, client);
		expect(reopened).toEqual(first);
		expect(state).toHaveBeenCalledTimes(1);
		expect(version).toHaveBeenCalledTimes(1);
		expect(storage.immutableWrites).toBe(1);
		if (reopened.status !== 'ready') throw new Error('Expected a ready fixture.');
		const confirmedState = {
			...reopened.contract,
			title: 'Confirmed Buyer',
			playbook: [
				{
					itemId,
					currentChangeId: 'confirmed-change' as Id<'contractChanges'>,
					appliedChangeId: 'confirmed-change' as Id<'contractChanges'>,
					currentOptionId: 'preferred',
					appliedOptionId: 'preferred',
					status: 'approved' as const,
					decisionId: null
				}
			],
			stateRevision: 1,
			reviews: { ...reopened.contract.reviews, playbook: { identity: 'playbook:1' } },
			lastOperationId: 'confirmed-operation'
		};
		const updatedCommit = storage.committedRevision(1);
		const updated = cache.updateState(id, confirmedState);
		expect(updated?.snapshot).toBe(reopened.snapshot);
		expect(updated?.contract).toMatchObject(confirmedState);
		await updatedCommit;
		expect(await cache.load(id, client)).toEqual(updated);
		releaseContractSnapshotCache();
		expect(await getContractSnapshotCache().load(id, client)).toEqual(updated);
		expect(state).toHaveBeenCalledTimes(1);
		expect(version).toHaveBeenCalledTimes(1);
		expect(storage.immutableWrites).toBe(1);
	});

	it('seeds confirmed content without a download, keeps newer revisions and rejects deleted seeds', async () => {
		const cache = getContractSnapshotCache();
		const data = fixture();
		const commit = storage.committedRevision(0);
		expect(cache.seedConfirmed(data)).toBe(data);
		await commit;
		const { client, state, version } = networkFixture();
		expect(await cache.load(id, client)).toBe(data);
		expect(state).not.toHaveBeenCalled();
		expect(version).not.toHaveBeenCalled();
		cache.updateState(id, {
			...data.contract,
			title: 'Latest',
			playbook: [],
			stateRevision: 2,
			reviews: { ...data.contract.reviews, playbook: { identity: 'playbook:2' } },
			lastOperationId: 'latest'
		});
		expect(cache.seedConfirmed(data)?.contract.stateRevision).toBe(2);
		expect(cache.peek(id)?.snapshot).toBe(data.snapshot);
		expect(storage.immutableWrites).toBe(1);
		cache.remove(id);
		expect(cache.seedConfirmed(data)).toBeUndefined();
		expect(await cache.load(id, client)).toEqual({ id, status: 'missing' });
	});
	it('sizes accepted approved wording once for memory and actual durable storage, preserving immutable reuse and validation', async () => {
		const data = fixture(),
			approved = data.approved!;
		const expectedBytes = JSON.stringify(approved).length * 2;
		const stringify = vi.spyOn(JSON, 'stringify');
		const durable = vi.spyOn(SnapshotStorage.prototype, 'putApproved');
		const cache = getContractSnapshotCache();
		const commit = storage.committedRevision(0);
		expect(cache.seedConfirmed(data)).toBe(data);
		await commit;
		expect(stringify.mock.calls.filter(([value]) => value === approved)).toHaveLength(1);
		expect(durable).toHaveBeenCalledExactlyOnceWith(
			id,
			approved,
			expectedBytes,
			expect.any(Function)
		);
		expect(await approvedRows()).toEqual([
			expect.objectContaining({ id: approved.documentId, bytes: expectedBytes, data: approved })
		]);
		expect(cache.rememberApproved(id, structuredClone(approved))).toBe(approved);
		expect(durable).toHaveBeenCalledTimes(1);
		const corrupt = {
			...approved,
			documentId: 'corrupt' as Id<'contractDocuments'>,
			documentRevision: -1
		};
		expect(cache.rememberApproved(id, corrupt)).toBeUndefined();
		expect(stringify.mock.calls.some(([value]) => value === corrupt)).toBe(false);
		cache.remove(id);
		expect(cache.rememberApproved(id, approved)).toBeUndefined();
		expect(durable).toHaveBeenCalledTimes(1);
	});

	it.each(['entry', 'byte'] as const)(
		'preserves real durable approved %s bounds with the shared computed size',
		async (bound) => {
			const cache = getContractSnapshotCache();
			const count = bound === 'entry' ? SNAPSHOT_ENTRIES + 1 : 3;
			const accepted: ReadyContract[] = [];
			for (let i = 0; i < count; i++) {
				const data = fixture();
				data.id = `bounded-${i}`;
				data.contract = {
					...data.contract,
					_id: data.id as Id<'savedContracts'>,
					documentId: `document-${i}` as Id<'contractDocuments'>
				};
				data.approved = {
					...data.approved!,
					documentId: data.contract.documentId,
					displayIdentity: `bounded:${i}`
				};
				if (bound === 'byte') {
					const block = data.approved.document.blocks[0];
					if (block.kind !== 'paragraph' || block.content[0].kind !== 'text')
						throw new Error('Expected text fixture');
					block.content[0].text = 'x'.repeat(6 * 1024 * 1024);
					data.approved.document.pieceGroups[0][0].origin.end = block.content[0].text.length;
				}
				const commit = storage.committedRevision(0);
				cache.seedConfirmed(data);
				await commit;
				accepted.push(data);
			}
			const rows = await approvedRows();
			expect(rows.length).toBeLessThanOrEqual(SNAPSHOT_ENTRIES);
			expect(rows.reduce((sum, row) => sum + row.bytes, 0)).toBeLessThanOrEqual(SNAPSHOT_BYTES);
			expect(rows.length).toBe(bound === 'entry' ? SNAPSHOT_ENTRIES : 2);
			expect(rows.some((row) => row.id === accepted[0].approved!.documentId)).toBe(false);
			expect(rows.some((row) => row.id === accepted.at(-1)!.approved!.documentId)).toBe(true);
			for (const row of rows) expect(row.bytes).toBe(JSON.stringify(row.data).length * 2);
		}
	);
});
