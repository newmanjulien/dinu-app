import { mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { reactive } from '../../support/observers.svelte';
import { settle } from '../../support/svelte';
import Harness from './BuyerLinkBarAdmissionHarness.svelte';

vi.mock('$lib/buyer/BuyerLinkBar.svelte', () => import('./BuyerLinkBarProbe.svelte'));

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
	if (component) await unmount(component);
	component = undefined;
	document.body.innerHTML = '';
});

it('shows a warm saved footer in the first settled render when both dependencies are ready', async () => {
	const source = {};
	const state = reactive({
		workspace: {
			source: { renderSource: source },
			viewer: { firstPagesReady: null as { source: object } | null }
		},
		latest: {
			data: null as null | { token: string } | undefined,
			error: undefined as Error | undefined,
			isLoading: false
		},
		available: true,
		interactionAdmitted: true
	});
	state.workspace.viewer.firstPagesReady = { source: state.workspace.source.renderSource };
	component = mount(Harness, { target: document.body, props: { state } });
	await settle();
	expect(document.querySelector('[data-buyer-link-bar="contract-a"]')).not.toBeNull();
});

it('admits the saved footer after matching first pages and a resolved link, then retains it through later page batches', async () => {
	const state = reactive({
		workspace: {
			source: { renderSource: null as object | null },
			viewer: { firstPagesReady: null as { source: object } | null }
		},
		latest: {
			data: undefined as null | { token: string } | undefined,
			error: undefined as Error | undefined,
			isLoading: true
		},
		available: true,
		interactionAdmitted: true
	});
	component = mount(Harness, {
		target: document.body,
		props: { state }
	});
	const bar = () => document.querySelector('[data-buyer-link-bar]');
	await settle();
	expect(bar()).toBeNull();
	state.latest.data = null;
	state.latest.isLoading = false;
	await settle();
	expect(bar()).toBeNull();
	const currentSource = {};
	state.workspace.source.renderSource = currentSource;
	state.workspace.viewer.firstPagesReady = { source: {} };
	await settle();
	expect(bar()).toBeNull();
	state.workspace.viewer.firstPagesReady = { source: state.workspace.source.renderSource };
	await settle();
	const firstBar = bar();
	expect(firstBar?.getAttribute('data-buyer-link-bar')).toBe('contract-a');
	state.workspace.viewer.firstPagesReady = null;
	state.workspace.source.renderSource = {};
	state.latest.isLoading = true;
	await settle();
	expect(bar()).toBe(firstBar);
	state.interactionAdmitted = false;
	await settle();
	expect(bar()).toBeNull();
	state.interactionAdmitted = true;
	await settle();
	expect(bar()).not.toBeNull();
});

it('withholds the footer when link availability is unknown, then admits an actionable error and hides when unavailable', async () => {
	const source = {};
	const state = reactive({
		workspace: {
			source: { renderSource: source },
			viewer: { firstPagesReady: null as { source: object } | null }
		},
		latest: { data: undefined, error: undefined as Error | undefined, isLoading: true },
		available: true,
		interactionAdmitted: true
	});
	state.workspace.viewer.firstPagesReady = { source: state.workspace.source.renderSource };
	component = mount(Harness, { target: document.body, props: { state } });
	const bar = () => document.querySelector('[data-buyer-link-bar]');
	await settle();
	expect(bar()).toBeNull();
	state.latest.isLoading = false;
	await settle();
	expect(bar()).toBeNull();
	state.latest.error = new Error('Link check failed');
	await settle();
	expect(bar()).not.toBeNull();
	state.available = false;
	await settle();
	expect(bar()).toBeNull();
});
