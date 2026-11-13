import { render } from 'svelte/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { page } from '../support/navigation.svelte';
import BuyerHarness from '../components/loading/BuyerLoadingHarness.svelte';
import Harness from '../components/loading/LoadingHarness.svelte';
const external = vi.hoisted(() => ({
	clerk: { isLoaded: false, auth: {}, session: null, user: null }
}));
vi.mock('svelte-clerk', () => ({ useClerkContext: () => external.clerk }));
vi.mock('$lib/auth/SessionStatus.svelte', () => import('../support/CsmChrome.svelte'));
vi.mock('$lib/auth/destination-code', () => ({ preloadDestination: async () => {} }));

it.each([
	['/contracts', '/(workspace)/contracts', false],
	['/login', '/(entry)/login', true]
])('server renders %s without waiting for authentication', (path, id, entry) => {
	page.url = new URL(path as string, 'https://test.local');
	page.route.id = id as string;
	page.params = {};
	page.data = {};
	const result = render(Harness, { props: { entry: Boolean(entry) } });
	expect(result.body).toContain('data-workspace-frame');
	expect(result.body).not.toContain('data-private-content');
	if (entry) expect(result.body).toContain('aria-label="Email"');
	else expect(result.body).toContain('role="status"');
	if (path === '/contracts') {
		mkdirSync('.svelte-kit/loading-fixtures', { recursive: true });
		writeFileSync('.svelte-kit/loading-fixtures/workspace.html', result.body);
	}
});

it('server renders buyer /contract while validation is unresolved', () => {
	page.url = new URL(`https://test.local/${'0'.repeat(39)}/contract`);
	page.route.id = '/(buyer)/[token=buyerCode]/contract';
	page.params = { token: '0'.repeat(39) };
	page.data = {};
	const result = render(BuyerHarness);
	const header = result.body.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1];
	expect(header).toContain('Opening contract…');
	expect(result.body).toContain('role="status"');
	expect(result.body).not.toContain('data-private-buyer');
});
