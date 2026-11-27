import { mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { reactive } from '../../support/observers.svelte';
import { settle } from '../../support/svelte';
import type { ContractBuyerLink } from '../../../src/lib/contract/saved';
import type { Id } from '../../../src/convex/_generated/dataModel';
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
	const state = reactive({
		buyerLink: null as ContractBuyerLink | null,
		hasUnreadComment: false,
		mode: 'negotiate' as 'negotiate' | 'comments'
	});
	component = mount(Harness, {
		target: document.body,
		props: { state }
	});
	await settle();
	const bar = document.querySelector('section[aria-label="Buyer link"]')!;
	const button = bar.querySelector<HTMLButtonElement>('[data-buyer-link-actions] button')!;
	const label = () =>
		button.querySelector('span.inline-grid > span:not([aria-hidden])')?.textContent;
	const reserved = button.querySelector('span.inline-grid > span[aria-hidden="true"]');
	expect(label()).toBe('Create link');
	expect(reserved?.textContent).toBe('Create link');
	expect(bar.textContent).toContain('Create a link to share this contract with the buyer.');
	expect(bar.querySelector('[role="group"][aria-label="Contract view"]')).toBeNull();

	state.buyerLink = {
		id: 'link-a' as Id<'buyerLinks'>,
		token: 'Ab3Cd4Ef5Gh6I',
		createdAt: 1,
		contentRevision: 0,
		concessions: {}
	};
	await settle();
	expect(document.querySelector('section[aria-label="Buyer link"]')).toBe(bar);
	expect(bar.querySelector('[data-buyer-link-actions] button')).toBe(button);
	expect(label()).toBe('Copy link');
	expect(reserved?.textContent).toBe('Create link');

	const toggle = bar.querySelector('[role="group"][aria-label="Contract view"]')!;
	const [negotiateBtn, commentsBtn] = toggle.querySelectorAll<HTMLButtonElement>('button');
	expect(negotiateBtn.getAttribute('aria-pressed')).toBe('true');
	expect(commentsBtn.getAttribute('aria-pressed')).toBe('false');
	expect(commentsBtn.textContent).not.toContain('unread');

	state.hasUnreadComment = true;
	await settle();
	expect(commentsBtn.textContent).toContain('unread');
	commentsBtn.click();
	await settle();
	expect(state.mode).toBe('comments');
	expect(commentsBtn.getAttribute('aria-pressed')).toBe('true');
});
