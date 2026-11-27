import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BuyerContract } from '../../../src/lib/buyer/contract.svelte';
import { BuyerSeller } from '../../../src/lib/buyer/seller.svelte';
import { page } from '../../support/navigation.svelte';
import { frameClock, settle } from '../../support/svelte';
import { controlledClient } from '../../support/transport';
import Harness from './BuyerHeaderHarness.svelte';

const context = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('convex-svelte', () => ({ useConvexClient: () => context.client }));

let component: ReturnType<typeof mount> | undefined;
let seller: BuyerSeller;
let clock: ReturnType<typeof frameClock>;
let network: ReturnType<typeof controlledClient>;

beforeEach(() => {
	vi.useFakeTimers();
	clock = frameClock();
	network = controlledClient();
	context.client = {
		...network.client,
		connectionState: () => ({ isWebSocketConnected: false }),
		subscribeToConnectionState: () => () => {}
	};
	page.url = new URL('https://test.local/Ab3Cd4Ef5Gh6I');
	page.route.id = '/(buyer)/[token=buyerCode]';
	page.params = { token: 'Ab3Cd4Ef5Gh6I' };
	page.data = {};
	vi.spyOn(BuyerSeller.prototype, 'mount').mockImplementation(function (this: BuyerSeller) {
		seller = this;
		return () => {};
	});
	vi.spyOn(BuyerContract.prototype, 'warmCode').mockImplementation(() => {});
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(null, { status: 204 }))
	);
});

afterEach(async () => {
	if (component) await unmount(component);
	component = undefined;
	document.body.innerHTML = '';
	vi.useRealTimers();
});

async function admitLink() {
	component = mount(Harness, { target: document.body });
	await settle();
	network.publish('buyerLinks:currentState', {
		kind: 'current',
		buyerName: 'Ocean Buyer',
		companyName: 'Ocean Company',
		buyerRefreshable: false,
		templateVersionId: 'version',
		title: 'Contract',
		contentRevision: 1,
		displayIdentity: 'published:1',
		concessions: {},
		appliedOverlays: []
	});
	await settle();
	expect(document.querySelector('[data-document-body]')).not.toBeNull();
	expect(
		document.querySelector('[data-document-body]')?.closest('[aria-hidden="true"]')
	).not.toBeNull();
	await clock.frame();
	await vi.advanceTimersByTimeAsync(0);
	await settle();
}

it('admits the buyer header before the heading and contract body on a cold load', async () => {
	await admitLink();
	seller.phase = 'buyer';
	await settle();
	expect(document.querySelector('header')?.textContent).toContain(
		'Review your contract and leave comments'
	);
	expect(document.querySelector('h1')).toBeNull();
	expect(
		document.querySelector('[data-document-body]')?.closest('[aria-hidden="true"]')
	).not.toBeNull();
	await clock.frame();
	await vi.advanceTimersByTimeAsync(0);
	await settle();
	expect(document.querySelector('h1')?.textContent).toContain(
		'This is your contract with Ocean Company'
	);
	expect(
		document.querySelector('[data-document-body]')?.closest('[aria-hidden="true"]')
	).toBeNull();
});

it('shows seller preview copy before revealing the preview body', async () => {
	await admitLink();
	seller.contractId =
		'contract-a' as import('../../../src/convex/_generated/dataModel').Id<'savedContracts'>;
	seller.phase = 'preview';
	await settle();
	const header = document.querySelector('header')!;
	expect(header.textContent).toContain('You are in buyer view.');
	expect(header.querySelector('[aria-label="Your account"]')).toBeNull();
	expect(document.querySelector('h1')).toBeNull();
	expect(
		document.querySelector('[data-document-body]')?.closest('[aria-hidden="true"]')
	).not.toBeNull();
	await clock.frame();
	await vi.advanceTimersByTimeAsync(0);
	await settle();
	expect(document.querySelector('h1')?.textContent).toContain('This is what Ocean Buyer sees');
	expect(
		document.querySelector('[data-document-body]')?.closest('[aria-hidden="true"]')
	).toBeNull();
});
