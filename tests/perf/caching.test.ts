import { api } from '../../src/convex/_generated/api';
import { getFunctionName } from 'convex/server';
import type { SnapshotClient } from '../../src/lib/contract/snapshot-cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getContractSnapshotCache,
	releaseContractSnapshotCache
} from '../../src/lib/contract/snapshot-cache';
import type { ReadyContract } from '../../src/lib/contract/snapshot-storage';
import type { Id } from '../../src/convex/_generated/dataModel';
import { block, item } from './fixtures';
import { observeSnapshotStorage } from './snapshot-storage-observer';
import { setCacheIdentity } from '../../src/lib/contract/browser-storage';

const id = 'synthetic-contract' as Id<'savedContracts'>;
const itemId = 'synthetic-item' as Id<'playbookItems'>;
const companyId = 'synthetic-company' as Id<'company'>;
function fixture(): ReadyContract {
	return {
		id,
		status: 'ready',
		contract: {
			_id: id,
			creatorId: 'synthetic-profile' as Id<'profiles'>,
			companyId,
			templateVersionId: 'synthetic-template' as Id<'templateVersions'>,
			_creationTime: 1,
			companyName: 'Synthetic Buyer',
			savedAt: 123,
			reviews: {},
			selectedConcessions: {},
			revision: 0
		},
		snapshot: {
			blockCount: 1,
			itemCount: 1,
			blocks: [block],
			items: [{ ...item, revision: 1, companyId, _id: itemId, _creationTime: 1 }]
		}
	};
}

function networkFixture() {
	const data = fixture();
	const state = vi.fn().mockResolvedValue({ ...data.contract, lastOperationId: null });
	const version = vi.fn().mockResolvedValue(data.snapshot);
	const client: SnapshotClient = {
		onUpdate: vi
			.fn<SnapshotClient['onUpdate']>()
			.mockImplementation((reference, _args, callback, onError) => {
				let subscribed = true;
				const work =
					getFunctionName(reference) === getFunctionName(api.savedContracts.state)
						? state()
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
					subscribed = false;
				};
				return Object.assign(unsubscribe, { unsubscribe, getCurrentValue: () => undefined });
			})
	};
	return { client, state, version };
}

describe('snapshot caching work', () => {
	let storage: ReturnType<typeof observeSnapshotStorage>;

	beforeEach(() => {
		storage = observeSnapshotStorage();
		vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
		vi.stubGlobal('window', {});
		setCacheIdentity({
			profileId: 'synthetic-profile' as Id<'profiles'>,
			membershipId: 'synthetic-membership' as Id<'memberships'>
		});
	});

	afterEach(async () => {
		releaseContractSnapshotCache();
		try {
			await storage.close();
		} finally {
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
		}
	});

	it('loads once from the network and reopens the same snapshot from memory', async () => {
		const { client, state, version } = networkFixture();
		const cache = getContractSnapshotCache();
		const committed = storage.committedRevision(0);
		const first = await cache.load(id, client);
		expect(first.status).toBe('ready');
		await committed;
		expect(await cache.load(id, client)).toBe(first);
		expect(state).toHaveBeenCalledTimes(1);
		expect(version).toHaveBeenCalledTimes(1);
		expect(storage.immutableWrites).toBe(1);
	});

	it('reopens from IndexedDB after releasing memory without another download', async () => {
		const { client, state, version } = networkFixture();
		const committed = storage.committedRevision(0);
		const first = await getContractSnapshotCache().load(id, client);
		expect(first.status).toBe('ready');
		await committed;
		releaseContractSnapshotCache();
		expect(await getContractSnapshotCache().load(id, client)).toEqual(first);
		expect(state).toHaveBeenCalledTimes(1);
		expect(version).toHaveBeenCalledTimes(1);
		expect(storage.immutableWrites).toBe(1);
	});

	it('persists confirmed state without rewriting the immutable snapshot', async () => {
		const { client, state, version } = networkFixture();
		const cache = getContractSnapshotCache();
		const initialCommit = storage.committedRevision(0);
		const first = await cache.load(id, client);
		expect(first.status).toBe('ready');
		await initialCommit;
		if (first.status !== 'ready') throw new Error('Expected a ready fixture.');
		const confirmedState = {
			companyName: 'Confirmed Buyer',
			reviews: {},
			selectedConcessions: { [itemId]: 'preferred' },
			revision: 1,
			lastOperationId: 'confirmed-operation'
		};
		const updatedCommit = storage.committedRevision(1);
		const updated = cache.updateState(id, confirmedState);
		expect(updated?.snapshot).toBe(first.snapshot);
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
			companyName: 'Latest',
			reviews: {},
			selectedConcessions: {},
			revision: 2,
			lastOperationId: 'latest'
		});
		expect(cache.seedConfirmed(data)?.contract.revision).toBe(2);
		expect(cache.peek(id)?.snapshot).toBe(data.snapshot);
		expect(storage.immutableWrites).toBe(1);
		cache.remove(id);
		expect(cache.seedConfirmed(data)).toBeUndefined();
		expect(await cache.load(id, client)).toEqual({ id, status: 'missing' });
	});
});
