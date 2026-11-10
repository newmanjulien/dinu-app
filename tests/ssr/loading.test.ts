import { render } from 'svelte/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { page } from '../lifecycle/navigation.svelte';
import BuyerHarness from '../lifecycle/BuyerLoadingHarness.svelte';
import Harness from '../lifecycle/LoadingHarness.svelte';
const external = vi.hoisted(() => ({
	clerk: { isLoaded: false, auth: {}, session: null, user: null }
}));
vi.mock('svelte-clerk', () => ({ useClerkContext: () => external.clerk }));
vi.mock('$lib/auth/SessionStatus.svelte', () => import('../lifecycle/CsmChrome.svelte'));
vi.mock('$lib/auth/destination-code', () => ({ preloadDestination: async () => {} }));

it.each([
	['/contracts', '/(workspace)/contracts', false],
	['/settings', '/(workspace)/settings', false],
	['/team', '/(workspace)/team', false],
	['/integrations/hubspot', '/(workspace)/integrations/[slug]', false],
	['/contracts/contract', '/(workspace)/contracts/(document)/[id]', false],
	['/template', '/(workspace)/template', false],
	['/login', '/(entry)/login', true],
	['/onboarding', '/(onboarding)/onboarding', true]
])('server renders %s without waiting for authentication', (path, id, entry) => {
	page.url = new URL(path as string, 'https://test.local');
	page.route.id = id as string;
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

it.each(['', '/contract'])(
	'server renders buyer %s while validation is unresolved',
	(destination) => {
		page.url = new URL(`https://test.local/${'0'.repeat(39)}${destination}`);
		const result = render(BuyerHarness);
		const header = result.body.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1];
		expect(header?.replace(/<[^>]*>/g, '').trim()).toBe('');
		expect(result.body).toContain('role="status"');
		expect(result.body).not.toContain('data-private-buyer');
	}
);
