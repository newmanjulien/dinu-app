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
	network.publish('buyerLinks:status', {
		kind: 'current',
		buyerName: 'Ocean Buyer',
		companyName: 'Ocean Company'
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

it('shows seller copy and a reserved avatar circle before the avatar read resolves', async () => {
	await admitLink();
	seller.viewer = {
		profile: { id: 'profile', name: 'Seller', email: 'seller@example.com' },
		role: 'admin',
		helpPreferences: { contract: true, buyerLink: true }
	} as BuyerSeller['viewer'];
	seller.phase = 'seller';
	await settle();
	const header = document.querySelector('header')!;
	expect(header.textContent).toContain('View as buyer');
	expect(header.textContent).not.toContain('contract');
	expect(header.querySelector('[aria-label="Your account"]')).not.toBeNull();
	expect(header.querySelector('[aria-label="Your account"] .rounded-full')).not.toBeNull();
	await clock.frame();
	await vi.advanceTimersByTimeAsync(0);
	await settle();
	expect(
		document.querySelector('[data-document-body]')?.closest('[aria-hidden="true"]')
	).toBeNull();
	expect(seller.headerAvatarReady).toBe(false);
	seller.preview = true;
	await settle();
	expect(header.textContent).toContain('You are in buyer view. Back to your view');
	expect(header.textContent).not.toContain('contract');
});
