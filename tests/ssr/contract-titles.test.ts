import { render } from 'svelte/server';
import { afterEach, expect, it, vi } from 'vitest';
import { load as savedLoad } from '../../src/routes/(workspace)/contracts/(document)/[id]/+page.server';
import { load as buyerLoad } from '../../src/routes/(buyer)/+layout.server';
import { page } from '../support/navigation.svelte';
import Harness from './ContractTitleHarness.svelte';

const routeRead = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/route-title', () => ({ readRouteData: routeRead }));

const buyerCode = 'Ab3Cd4Ef5Gh6I';
const request = () => ({ signal: new AbortController().signal });
const savedEvent = () => ({
	params: { id: 'saved-a' },
	locals: { auth: () => ({ getToken: async () => 'saved-credential' }) },
	request: request()
});
const buyerEvent = (
	credential: { kind: 'anonymous' } | { kind: 'account'; token: string } | { kind: 'unknown' }
) => ({
	params: { token: buyerCode },
	locals: { buyerPageCredential: async () => credential },
	request: request(),
	cookies: { get: () => undefined, getAll: () => [], delete: vi.fn() }
});
async function loadSaved() {
	const data = await savedLoad(savedEvent() as never);
	if (!data) throw new Error('Saved title load returned no data.');
	return data;
}
async function loadBuyer(credential: Parameters<typeof buyerEvent>[0]) {
	const data = await buyerLoad(buyerEvent(credential) as never);
	if (!data) throw new Error('Buyer title load returned no data.');
	return data;
}
function firstResponseTitle(path: string, routeId: string, data: Record<string, unknown>) {
	page.url = new URL(path, 'https://test.local');
	page.route.id = routeId;
	page.params = routeId === '/(buyer)/[token=buyerCode]' ? { token: buyerCode } : { id: 'saved-a' };
	page.data = data;
	const html = render(Harness).head;
	return html.match(/<title>(.*?)<\/title>/u)?.[1];
}

afterEach(() => {
	routeRead.mockReset();
	page.data = {};
});

it.each([
	[{ kind: 'current', buyerName: 'Ocean Buyer' }, 'Negotiate with Ocean Buyer'],
	[{ kind: 'current', buyerName: null }, 'Negotiate a contract'],
	[{ kind: 'unavailable' }, 'Contract not found']
])('sends the authorized saved-contract title in the first HTML for %j', async (current, title) => {
	routeRead.mockResolvedValue(current);
	const data = await loadSaved();
	expect(data.resolvedRouteTitle.title).toBe(title);
	expect(
		firstResponseTitle('/contracts/saved-a', '/(workspace)/contracts/(document)/[id]', data)
	).toBe(title);
	expect(routeRead.mock.calls[0][3]).toBe('saved-credential');
});

it('keeps a failed saved-contract read distinct from a genuinely absent buyer name', async () => {
	routeRead.mockRejectedValue(new Error('read failed'));
	const data = await loadSaved();
	expect(data.resolvedRouteTitle).toEqual({ kind: 'error', title: 'Couldn’t load contract' });
	expect(
		firstResponseTitle('/contracts/saved-a', '/(workspace)/contracts/(document)/[id]', data)
	).toBe('Couldn’t load contract');
});

it.each([
	[
		{ kind: 'anonymous' },
		{ kind: 'current', audience: 'buyer', buyerName: 'Ocean Buyer' },
		'Review your contract'
	],
	[
		{ kind: 'account', token: 'seller-credential' },
		{ kind: 'current', audience: 'buyer', buyerName: 'Ocean Buyer' },
		'Review your contract'
	],
	[
		{ kind: 'account', token: 'seller-credential' },
		{ kind: 'current', audience: 'seller', buyerName: 'Ocean Buyer' },
		'Leave comments for Ocean Buyer'
	],
	[
		{ kind: 'account', token: 'seller-credential' },
		{ kind: 'current', audience: 'seller', buyerName: null },
		'Leave comments'
	],
	[{ kind: 'anonymous' }, { kind: 'unavailable' }, 'Link unavailable'],
	[
		{ kind: 'account', token: 'seller-credential' },
		{ kind: 'account-error' },
		'Couldn’t check your account'
	]
] as const)(
	'sends the verified buyer-link title in the first HTML for %j and %j',
	async (credential, current, title) => {
		routeRead.mockResolvedValue(current);
		const data = await loadBuyer(credential);
		expect(data.resolvedRouteTitle.title).toBe(title);
		expect(firstResponseTitle(`/${buyerCode}`, '/(buyer)/[token=buyerCode]', data)).toBe(title);
		expect(routeRead.mock.calls[0][3]).toBe(
			credential.kind === 'account' ? credential.token : undefined
		);
		expect(JSON.stringify(data)).not.toContain('seller-credential');
	}
);

it('reports account verification and route-read failures as final error titles', async () => {
	const unknown = await loadBuyer({ kind: 'unknown' });
	expect(unknown.resolvedRouteTitle).toEqual({
		kind: 'account-error',
		title: 'Couldn’t check your account'
	});
	expect(routeRead).not.toHaveBeenCalled();
	routeRead.mockRejectedValue(new Error('read failed'));
	const failed = await loadBuyer({ kind: 'anonymous' });
	expect(failed.resolvedRouteTitle).toEqual({ kind: 'error', title: 'Couldn’t open contract' });
	expect(firstResponseTitle(`/${buyerCode}`, '/(buyer)/[token=buyerCode]', failed)).toBe(
		'Couldn’t open contract'
	);
});
