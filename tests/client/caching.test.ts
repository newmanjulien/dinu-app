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
			playbookReviewIdentity: 'playbook:0',
			buyerLinkReviewIdentity: 'buyer-link:0',
			playbookCompletion: null,
			buyerLinkCompletion: null,
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
			playbookReviewIdentity: 'playbook:1',
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
			playbookReviewIdentity: 'playbook:2',
			lastOperationId: 'latest'
		});
		expect(cache.seedConfirmed(data)?.contract.stateRevision).toBe(2);
		expect(cache.peek(id)?.snapshot).toBe(data.snapshot);
		expect(storage.immutableWrites).toBe(1);
		cache.remove(id);
		expect(cache.seedConfirmed(data)).toBeUndefined();
		expect(await cache.load(id, client)).toEqual({ id, status: 'missing' });
	});
});
