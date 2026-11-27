import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BuyerContract, type BuyerDocumentContent } from '../../../src/lib/buyer/contract.svelte';
import { BuyerLinkController } from '../../../src/lib/buyer/links.svelte';
import { BuyerLinkCopyFeedback } from '../../../src/lib/buyer/copy-feedback.svelte';
import { HubSpotDeals } from '../../../src/lib/hubspot-deals.svelte';
import { DiscussionSession } from '../../../src/lib/discussions/session.svelte';
import { ReadAttempt } from '../../../src/lib/auth/attempt';
import { api } from '../../../src/convex/_generated/api';
import { getFunctionName, type FunctionReference, type FunctionReturnType } from 'convex/server';
import { queryOnce, type SnapshotClient } from '../../../src/lib/query-once';
import type { Id } from '../../../src/convex/_generated/dataModel';

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
const buyerCode = 'Ab3Cd4Ef5Gh6I';
const buyerState: FunctionReturnType<typeof api.buyerLinks.currentState> = {
	templateVersionId: 'version' as Id<'templateVersions'>,
	kind: 'current',
	companyName: 'Ocean Company',
	buyerName: 'Ocean Buyer',
	buyerRefreshable: false,
	displayIdentity: 'approved:0',
	title: 'Contract',
	contentRevision: 0,
	concessions: {},
	appliedOverlays: []
};
const buyerContent: BuyerDocumentContent = {
	...buyerState,
	blocks: [],
	rawExplanations: []
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
	const { client, reads } = snapshots(api.buyerLinks.currentState);
	const accept = vi.fn(),
		fail = vi.fn();
	const replaced = new ReadAttempt(15_000);
	const first = queryOnce(
		client,
		api.buyerLinks.currentState,
		{ token: buyerCode },
		replaced.signal
	).then(accept);
	const cancellation = expect(first).rejects.toThrow('replaced');
	replaced.abort();
	reads[0].receive(buyerState);
	await cancellation;
	expect(accept).not.toHaveBeenCalled();
	const attempt = new ReadAttempt(15_000);
	const second = queryOnce(
		client,
		api.buyerLinks.currentState,
		{ token: buyerCode },
		attempt.signal
	).then(accept, fail);
	await vi.advanceTimersByTimeAsync(15_001);
	await second;
	expect(fail).toHaveBeenCalledTimes(1);
	expect(reads[1].release).toHaveBeenCalledTimes(1);
	reads[1].receive(buyerState);
	await Promise.resolve();
	expect(accept).not.toHaveBeenCalled();
});
it('clears discussions on delivered access rejection and recovers on retry', async () => {
	const { client, reads } = snapshots(api.discussions.list);
	const session = new DiscussionSession(
		client as unknown as ConstructorParameters<typeof DiscussionSession>[0],
		{ kind: 'buyer', token: buyerCode },
		() => 1,
		{ policy: () => ({ readOnly: true, generation: 0 }) }
	);
	session.setActive(true);
	const thread: FunctionReturnType<typeof api.discussions.list>['threads'][number] = {
		id: 'thread' as Id<'discussionThreads'>,
		replies: [],
		contentRevision: 1,
		anchor: {
			start: { kind: 'source', point: { sourceKey: 'p', offset: 0 } },
			end: { kind: 'source', point: { sourceKey: 'p', offset: 1 } },
			quote: 'x'
		},
		root: {
			id: 'message' as Id<'discussionMessages'>,
			text: 'Comment',
			revision: 1,
			createdAt: 0,
			operationId: null,
			author: { key: 'buyer', name: 'Buyer', avatarUrl: null, buyer: true }
		}
	};
	reads[0].receive({ viewer: null, threads: [thread] });
	expect(session.authorized).toBe(true);
	expect(session.threads).toEqual([thread]);
	reads[0].fail(new Error('Access revoked'));
	expect(session.authorized).toBe(false);
	expect(session.threads).toEqual([]);
	expect(session.error).toContain('Comments are unavailable');
	session.retry();
	reads.at(-1)!.receive({ viewer: null, threads: [thread] });
	expect(session.authorized).toBe(true);
	expect(session.threads).toEqual([thread]);
	session.destroy();
});

it('retains the accepted buyer resource through an opening retry and tears it down on access withdrawal', () => {
	const owner = new BuyerContract(buyerCode, { onUpdate: unused }, buyerContent.templateVersionId);
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
	const buyerLink = {
		id: 'link' as Id<'buyerLinks'>,
		token: buyerCode,
		createdAt: 0,
		contentRevision: 0,
		concessions: {}
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
			query: async (query) => {
				expect(getFunctionName(query)).toBe(getFunctionName(api.contracts.state));
				return { buyerLink } as unknown as FunctionReturnType<typeof query>;
			},
			action: async (action) => {
				expect(getFunctionName(action)).toBe(getFunctionName(api.buyerLinks.ensureLatest));
				return {
					id: buyerLink.id,
					token: buyerLink.token,
					createdAt: buyerLink.createdAt,
					created: false
				} as FunctionReturnType<typeof action>;
			}
		},
		{
			reserveForLink: () => ({
				needsSave: false,
				currentState: undefined,
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
	expect(feedback.notice).not.toBeNull();
	await vi.advanceTimersByTimeAsync(2_000);
	await links.copy();
	await vi.advanceTimersByTimeAsync(501);
	expect(feedback.notice).not.toBeNull();
	await vi.advanceTimersByTimeAsync(2_000);
	expect(feedback.notice).toBeNull();
	writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'));
	await links.copy();
	expect(links.error).toBe('Couldn’t copy the link. Try again.');
	expect(feedback.notice).toBeNull();
	links.destroy();
	feedback.destroy();
	Reflect.deleteProperty(navigator, 'clipboard');
});
