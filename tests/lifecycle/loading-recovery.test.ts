import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BuyerContract } from '../../src/lib/buyer/contract.svelte';
import { BuyerLinkController } from '../../src/lib/buyer/links.svelte';
import { BuyerLinkCopyFeedback } from '../../src/lib/buyer/copy-feedback.svelte';
import { HubSpotDeals } from '../../src/lib/hubspot-deals.svelte';
import { LiveDiscussionPages } from '../../src/lib/discussions/live-pages.svelte';
import { ReadAttempt } from '../../src/lib/auth/attempt';
import { api } from '../../src/convex/_generated/api';
import { getFunctionName, type FunctionReference, type FunctionReturnType } from 'convex/server';
import { queryOnce, type SnapshotClient } from '../../src/lib/query-once';
import type { Id } from '../../src/convex/_generated/dataModel';

// Only the selected query can deliver a result through this fixture.
function snapshots<Query extends FunctionReference<'query'>>(expectedQuery: Query) {
	const reads: {
		receive: (value: FunctionReturnType<Query>) => void;
		fail: (error: Error) => void;
		release: ReturnType<typeof vi.fn>;
	}[] = [];
	const client: SnapshotClient = {
		onUpdate(query, _args, receive, fail) {
			expect(getFunctionName(query)).toBe(getFunctionName(expectedQuery));
			const release = vi.fn();
			reads.push({
				// The checked query identity above correlates the erased subscription callback.
				receive: (value) => receive(value as FunctionReturnType<typeof query>),
				fail: (error) => {
					fail?.(error);
				},
				release
			});
			return release;
		}
	};
	return { client, reads };
}
const membershipId = 'member' as Id<'memberships'>;
const contractId = 'contract' as Id<'savedContracts'>;
const buyerContent: FunctionReturnType<typeof api.buyerLinks.content> = {
	title: 'Contract',
	buyerRevision: 0,
	blocks: [],
	items: [],
	selections: [],
	templateItems: [],
	explanations: []
};
const unused = () => {
	throw new Error('Unused fixture capability');
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('evicts a hung coalesced deal request and ignores its late completion after a successful retry', async () => {
	let late!: (value: unknown) => void;
	const action = vi
		.fn()
		.mockImplementationOnce(() => new Promise((resolve) => (late = resolve)))
		.mockResolvedValue({ deals: [] });
	const owner = new HubSpotDeals({
		client: { action },
		membershipId: 'member' as Id<'memberships'>,
		identity: () => 'session',
		connection: {
			data: {
				status: 'connected',
				enabled: true,
				connectionId: 'connection' as Id<'hubspotConnections'>,
				accountId: 'account',
				installedAt: 1,
				configured: true,
				companyReadGranted: true,
				shared: true,
				removal: null,
				quotes: {
					installationId: null,
					epoch: 0,
					installed: false,
					connected: false,
					enabled: false,
					pushEnabled: false
				}
			},
			error: undefined
		}
	});
	const first = owner.load();
	expect(owner.load('', true)).toBe(first);
	const rejection = expect(first).rejects.toThrow('timed out');
	await vi.advanceTimersByTimeAsync(15_001);
	await rejection;
	const second = await owner.load('', true);
	expect(action).toHaveBeenCalledTimes(2);
	expect(owner.initialPage).toBe(second);
	late({ deals: [{ id: 'obsolete' }] });
	await Promise.resolve();
	expect(owner.initialPage).toBe(second);
	owner.destroy();
});
it('bounds snapshot acquisition and ignores results after a buyer view is replaced', async () => {
	const { client, reads } = snapshots(api.buyerLinks.content);
	const accept = vi.fn(),
		fail = vi.fn();
	const replaced = new ReadAttempt(15_000);
	const first = queryOnce(
		client,
		api.buyerLinks.content,
		{ token: '0'.repeat(39) },
		replaced.signal
	).then(accept);
	const cancellation = expect(first).rejects.toThrow('replaced');
	replaced.abort();
	reads[0].receive(buyerContent);
	await cancellation;
	expect(accept).not.toHaveBeenCalled();
	const attempt = new ReadAttempt(15_000);
	const second = queryOnce(
		client,
		api.buyerLinks.content,
		{ token: '0'.repeat(39) },
		attempt.signal
	).then(accept, fail);
	await vi.advanceTimersByTimeAsync(15_001);
	await second;
	expect(fail).toHaveBeenCalledTimes(1);
	expect(reads[1].release).toHaveBeenCalledTimes(1);
	reads[1].receive(buyerContent);
	await Promise.resolve();
	expect(accept).not.toHaveBeenCalled();
});
it('retains accepted discussions through a local page timeout but clears it on delivered access rejection', async () => {
	const { client, reads } = snapshots(api.discussions.threads);
	const history = new LiveDiscussionPages<
		FunctionReturnType<typeof api.discussions.threads>['page'][number]
	>((paginationOpts, receive, fail) =>
		client.onUpdate(
			api.discussions.threads,
			{ access: { membershipId, id: contractId }, paginationOpts },
			receive,
			fail
		)
	);
	history.reset();
	reads[0].receive({
		page: [
			{
				id: 'thread' as Id<'discussionThreads'>,
				anchor: {
					start: { kind: 'source', point: { sourceKey: 'p', offset: 0 } },
					end: { kind: 'source', point: { sourceKey: 'p', offset: 1 } },
					quote: 'x'
				},
				type: 'comment',
				applied: false,
				root: {
					id: 'message' as Id<'discussionMessages'>,
					text: 'Comment',
					revision: 1,
					deleted: false,
					createdAt: 0,
					author: { key: 'buyer', name: 'Buyer', avatarUrl: null, buyer: true }
				}
			}
		],
		isDone: false,
		continueCursor: 'next'
	});
	await Promise.resolve();
	const rows = history.rows;
	history.loadMore();
	await vi.advanceTimersByTimeAsync(15_001);
	expect(history.error?.message).toContain('timed out');
	expect(history.rows[0]).toEqual(rows[0]);
	expect(history.authorized).toBe(true);
	history.retry();
	reads.at(-1)!.fail(new Error('Access revoked'));
	expect(history.rows).toEqual([]);
	expect(history.authorized).toBe(false);
	history.destroy();
});

it('retains the accepted buyer resource through an opening retry and tears it down on access withdrawal', () => {
	const owner = new BuyerContract('token', { onUpdate: unused });
	owner.allowed = true;
	owner.content = buyerContent;
	owner.Host = unused;
	owner.mountReady = true;
	const scheduler = owner.scheduler,
		Host = owner.Host,
		content = owner.content,
		generation = owner.generation;
	const log = vi.spyOn(console, 'error').mockImplementation(() => {});
	owner.fail(generation, 'opening');
	owner.retry();
	expect(owner.scheduler).toBe(scheduler);
	expect(owner.Host).toBe(Host);
	expect(owner.content).toBe(content);
	expect(owner.mountReady).toBe(true);
	expect(owner.generation).toBe(generation);
	owner.setAccess(false);
	expect(owner.mountReady).toBe(false);
	expect(owner.content).toBeUndefined();
	expect(owner.generation).toBeGreaterThan(generation);
	owner.destroy();
	log.mockRestore();
});
it('reports successful clipboard writes to one feedback owner and extends dismissal after the latest copy', async () => {
	const feedback = new BuyerLinkCopyFeedback();
	const writeText = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
	const latest: NonNullable<FunctionReturnType<typeof api.buyerLinks.latest>> = {
		id: 'link' as Id<'buyerLinks'>,
		token: '0'.repeat(39),
		createdAt: 0
	};
	const links = new BuyerLinkController(
		{
			connectionState: () => ({
				isWebSocketConnected: true,
				hasInflightRequests: false,
				timeOfOldestInflightRequest: null,
				hasEverConnected: true,
				connectionCount: 1,
				connectionRetries: 0,
				inflightMutations: 0,
				inflightActions: 0
			}),
			query: unused,
			action: async (action) => {
				expect(getFunctionName(action)).toBe(getFunctionName(api.buyerLinkActions.ensureLatest));
				return latest as FunctionReturnType<typeof action>;
			},
			mutation: unused
		},
		{
			reserveForLink: () => ({
				needsSave: false,
				get editor() {
					return unused();
				},
				release: () => {}
			})
		},
		membershipId,
		contractId,
		feedback.show
	);
	await links.copy();
	expect(feedback.confirmation).not.toBeNull();
	await vi.advanceTimersByTimeAsync(2_000);
	await links.copy();
	await vi.advanceTimersByTimeAsync(501);
	expect(feedback.confirmation).not.toBeNull();
	await vi.advanceTimersByTimeAsync(2_000);
	expect(feedback.confirmation).toBeNull();
	writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'));
	await links.copy();
	expect(links.manualUrl).toBe(`${location.origin}/${latest.token}`);
	expect(feedback.confirmation).toBeNull();
	links.destroy();
	feedback.destroy();
	Reflect.deleteProperty(navigator, 'clipboard');
});
