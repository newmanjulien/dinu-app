import { mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { reactive } from '../../support/observers.svelte';
import { settle } from '../../support/svelte';
import type { useReadQuery } from '../../../src/lib/auth/read-query.svelte';
import { api } from '../../../src/convex/_generated/api';
import Harness from './BuyerLinkBarHarness.svelte';

vi.mock('convex-svelte', () => ({ useConvexClient: () => ({}) }));

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
	if (component) await unmount(component);
	component = undefined;
	document.body.innerHTML = '';
	vi.unstubAllGlobals();
});

it('keeps the actual footer button stable as a new buyer link becomes available', async () => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		}
	);
	const latest = reactive({
		data: null as null | { token: string },
		error: undefined as Error | undefined,
		isLoading: false,
		retry: vi.fn()
	});
	component = mount(Harness, {
		target: document.body,
		props: {
			latest: latest as unknown as ReturnType<typeof useReadQuery<typeof api.buyerLinks.latest>>
		}
	});
	await settle();
	const bar = document.querySelector('section[aria-label="Buyer link"]')!;
	const button = bar.querySelector('button')!;
	const label = () =>
		button.querySelector('span.inline-grid > span:not([aria-hidden])')?.textContent;
	const reserved = button.querySelector('span.inline-grid > span[aria-hidden="true"]');
	expect(label()).toBe('Create link');
	expect(reserved?.textContent).toBe('Create link');
	expect(bar.textContent).toContain('Create a link to share this contract with the buyer.');

	latest.data = { token: 'Ab3Cd4Ef5Gh6I' };
	await settle();
	expect(document.querySelector('section[aria-label="Buyer link"]')).toBe(bar);
	expect(bar.querySelector('button')).toBe(button);
	expect(label()).toBe('Copy link');
	expect(bar.querySelector('a')?.textContent).toBe('Open link');
	expect(reserved?.textContent).toBe('Create link');

	latest.error = new Error('Link check failed');
	await settle();
	expect(label()).toBe('Retry');
	expect(button).toHaveProperty('disabled', false);
	expect(bar.querySelector('[role="alert"]')?.textContent).toContain('Please try again');
});
