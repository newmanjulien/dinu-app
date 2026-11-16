import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BuyerContract } from '../../../src/lib/buyer/contract.svelte';
import { createDocumentWorkspace } from '../../../src/lib/document/runtime/workspace-factory';
import { orderedTools, type ToolStates } from '../../../src/lib/components/document/document-tools';
import { csmState } from '../../support/csm-state.svelte';
import { documentDom } from '../../support/document-dom';
import { controlledClient, deferred } from '../../support/transport';
import { settle } from '../../support/svelte';
import Harness from './ToolsHelpHarness.svelte';

const context = vi.hoisted(() => ({
	client: undefined as unknown,
	search: undefined as
		| Promise<typeof import('../../../src/lib/components/document/DocumentSearchTools.svelte')>
		| undefined,
	starts: [] as string[]
}));
vi.mock('convex-svelte', () => ({ useConvexClient: () => context.client }));
vi.mock('../../../src/lib/components/document/document-tools', async (original) => ({
	...(await original<typeof import('../../../src/lib/components/document/document-tools')>()),
	loadDocumentSearch: () => {
		context.starts.push('search');
		return (
			context.search ?? import('../../../src/lib/components/document/DocumentSearchTools.svelte')
		);
	}
}));
let component: ReturnType<typeof mount> | undefined;
let buyer: BuyerContract | undefined;
let workspace: ReturnType<typeof createDocumentWorkspace>;
let dom: ReturnType<typeof documentDom>;
beforeEach(() => {
	vi.useFakeTimers();
	dom = documentDom();
	HTMLDialogElement.prototype.showModal = function () {
		this.open = true;
	};
	HTMLDialogElement.prototype.close = function () {
		this.open = false;
	};
	context.starts = [];
	context.search = undefined;
});
afterEach(async () => {
	if (component) await unmount(component);
	component = undefined;
	buyer?.destroy();
	buyer = undefined;
	workspace?.renderer.destroy();
	workspace?.source.destroy();
	document.body.innerHTML = '';
	dom.destroy();
	vi.useRealTimers();
});
function fixture(variant: 'rep' | 'template' | 'buyer-template' | 'buyer' = 'rep') {
	const state = csmState();
	state.viewer.helpPreferences.rep = true;
	const network = controlledClient((read) => {
		if (read.name === 'hubspotConnections:status') context.starts.push('policy');
	});
	context.client = { ...network.client, mutation: vi.fn(async () => null) };
	workspace = createDocumentWorkspace({ kind: 'prose', blocks: { data: undefined } });
	const download = vi.fn();
	if (variant === 'buyer') {
		buyer = new BuyerContract('Ab3Cd4Ef5Gh6I', network.client);
		buyer.allowed = true;
		buyer.target = document.createElement('div');
	}
	component = mount(Harness, {
		target: document.body,
		props: { state, workspace, variant: variant === 'buyer' ? 'rep' : variant, buyer, download }
	});
	return { network, download };
}
function names() {
	return [...document.querySelectorAll('nav[aria-label="Document tools"]')].map((rail) =>
		[...rail.querySelectorAll('button,a')].map((tool) =>
			tool.getAttribute('aria-label')?.includes('search') ||
			tool.getAttribute('aria-label')?.includes('Search')
				? 'Search'
				: tool.getAttribute('aria-label')?.includes('Download') ||
					  tool.getAttribute('aria-label')?.includes('download')
					? 'Download'
					: tool.getAttribute('aria-label')?.includes('settings')
						? 'Settings'
						: 'Help'
		)
	);
}
const connection = (installed: boolean) => ({
	enabled: true,
	status: 'connected',
	quotes: { installed }
});
it('starts search and shared policy together, then reveals the ready disabled prefix on both rails in order', async () => {
	const search =
		deferred<typeof import('../../../src/lib/components/document/DocumentSearchTools.svelte')>();
	context.search = search.promise;
	const f = fixture();
	await settle();
	expect(context.starts).toEqual(expect.arrayContaining(['search', 'policy']));
	expect(f.network.live('hubspotConnections:status')).toHaveLength(1);
	expect(names()).toEqual([['Search'], ['Search']]);
	expect(
		document.querySelector<HTMLButtonElement>('[aria-label="Search document"]')!.disabled
	).toBe(true);
	search.resolve(await import('../../../src/lib/components/document/DocumentSearchTools.svelte'));
	await settle();
	expect(names()).toEqual([['Search'], ['Search']]);
	expect(
		document.querySelector<HTMLButtonElement>('[aria-label="Search document"]')!.disabled
	).toBe(true);
	f.network.publish('hubspotConnections:status', connection(true));
	await settle();
	expect(names()).toEqual([
		['Search', 'Download', 'Settings', 'Help'],
		['Search', 'Download', 'Settings', 'Help']
	]);
	document.querySelector<HTMLButtonElement>('[aria-label="How Dinu works"]')?.click();
	await settle();
	expect(document.querySelector('dialog')).not.toBeNull();
	expect(document.querySelector('dialog')!.textContent).toContain("Don't show this again");
	expect(workspace.viewer.displayedSnapshot).toBeNull();
	expect(f.download).not.toHaveBeenCalled();
});
it('holds lower tools through reverse readiness and admits all consecutive ready tools in one flush, skipping absent download', async () => {
	const search =
		deferred<typeof import('../../../src/lib/components/document/DocumentSearchTools.svelte')>();
	context.search = search.promise;
	const f = fixture();
	await settle();
	f.network.publish('hubspotConnections:status', connection(false));
	await settle();
	expect(names()).toEqual([
		['Search', 'Settings', 'Help'],
		['Search', 'Settings', 'Help']
	]);
	search.resolve(await import('../../../src/lib/components/document/DocumentSearchTools.svelte'));
	await settle();
	expect(names()).toEqual([
		['Search', 'Settings', 'Help'],
		['Search', 'Settings', 'Help']
	]);
});
it.each(['error', 'timeout'])(
	'resolves actual shared integration %s to an ordered retry slot and retries the same observation owner',
	async (kind) => {
		const f = fixture();
		for (let i = 0; i < 10 && f.network.live('hubspotConnections:status').length === 0; i++)
			await settle();
		expect(names()).toEqual([['Search'], ['Search']]);
		const observation = f.network.live('hubspotConnections:status')[0];
		if (kind === 'error') observation.error(new Error('Integration failed'));
		else await vi.advanceTimersByTimeAsync(15_001);
		await settle();
		expect(names()).toEqual([
			['Search', 'Download', 'Settings', 'Help'],
			['Search', 'Download', 'Settings', 'Help']
		]);
		const retry = document.querySelector<HTMLButtonElement>(
			'[aria-label="Retry download availability"]'
		)!;
		expect(retry.disabled).toBe(false);
		retry.click();
		await settle();
		expect(observation.released).toBe(true);
		expect(f.network.live('hubspotConnections:status')).toHaveLength(1);
		expect(names()).toEqual([['Search'], ['Search']]);
		f.network.publish('hubspotConnections:status', connection(false));
		await settle();
		expect(names()).toEqual([
			['Search', 'Settings', 'Help'],
			['Search', 'Settings', 'Help']
		]);
		expect(f.download).not.toHaveBeenCalled();
	}
);
it('resolves a failed upper search module into retry without starving help, then recovers disabled search', async () => {
	const search =
		deferred<typeof import('../../../src/lib/components/document/DocumentSearchTools.svelte')>();
	context.search = search.promise;
	const f = fixture();
	await settle();
	f.network.publish('hubspotConnections:status', connection(false));
	search.reject(new Error('Search download failed'));
	await settle();
	expect(names()).toEqual([
		['Search', 'Settings', 'Help'],
		['Search', 'Settings', 'Help']
	]);
	context.search = import('../../../src/lib/components/document/DocumentSearchTools.svelte');
	await context.search;
	document.querySelector<HTMLButtonElement>('[aria-label="Retry document search"]')!.click();
	await settle();
	expect(document.querySelector('[aria-label="Retry document search"]')).toBeNull();
	expect(
		document.querySelector<HTMLButtonElement>('[aria-label="Search document"]')!.disabled
	).toBe(true);
});
it.each(['template', 'buyer-template'] as const)(
	'keeps %s help manual and available without pagination or integration applicability',
	async (variant) => {
		fixture(variant);
		await settle();
		expect(names()).toEqual([
			['Search', 'Help'],
			['Search', 'Help']
		]);
		expect(document.querySelector('dialog')).toBeNull();
		const help = [
			...document
				.querySelector('nav[aria-label="Document tools"]')!
				.querySelectorAll<HTMLButtonElement>('button')
		].at(-1)!;
		help.click();
		await settle();
		expect(document.querySelector('dialog')).not.toBeNull();
		expect(document.querySelector('dialog input[type="checkbox"]')).toBeNull();
	}
);
it('reconciles every readiness combination as an ordered applicable prefix', () => {
	for (const search of ['pending', 'ready', 'failed'] as const)
		for (const download of ['pending', 'absent', 'present'] as const)
			for (const settings of ['pending', 'absent', 'present'] as const) {
				const states: ToolStates = {
					search: { applicability: 'present', display: search },
					download: { applicability: download, display: 'ready', enabled: false },
					settings: { applicability: settings, display: 'ready', enabled: false },
					help: { applicability: 'present', display: 'ready', enabled: true }
				};
				const visible = [...orderedTools(states)];
				if (search === 'pending') expect(visible).toEqual([]);
				else if (download === 'pending') expect(visible).toEqual(['search']);
				else if (settings === 'pending')
					expect(visible).toEqual(download === 'present' ? ['search', 'download'] : ['search']);
				else
					expect(visible).toEqual([
						'search',
						...(download === 'present' ? ['download'] : []),
						...(settings === 'present' ? ['settings'] : []),
						'help'
					]);
			}
});

it.each(['preference', 'preview'] as const)(
	'preserves public buyer %s policy with the shared search adapter and page-owned rail',
	async (kind) => {
		const search =
			deferred<typeof import('../../../src/lib/components/document/DocumentSearchTools.svelte')>();
		context.search = search.promise;
		fixture('buyer');
		const save = vi.fn(async () => null);
		buyer!.help.configure(
			kind === 'preview'
				? { kind: 'preview', identity: 'profile' }
				: {
						kind: 'preference',
						identity: 'buyer',
						confirmation: 'save',
						hidden: false,
						save,
						current: () => true
					}
		);
		await settle();
		expect(names()).toEqual([
			['Search', 'Download', 'Help'],
			['Search', 'Download', 'Help']
		]);
		search.resolve(await import('../../../src/lib/components/document/DocumentSearchTools.svelte'));
		await settle();
		expect(names()).toEqual([
			['Search', 'Download', 'Help'],
			['Search', 'Download', 'Help']
		]);
		expect(document.querySelector('dialog')).toBeNull();
		workspace.viewer.pagesVisible = true;
		await settle();
		expect(document.querySelector('dialog')).toBeNull();
		workspace.viewer.interactionEnabled = true;
		await settle();
		if (kind === 'preview') {
			expect(document.querySelector('dialog')).toBeNull();
			document
				.querySelector<HTMLButtonElement>('[aria-label="How to review this contract"]')!
				.click();
			await settle();
			expect(document.querySelector('dialog')).not.toBeNull();
			expect(document.querySelector('dialog input[type="checkbox"]')).toBeNull();
		} else {
			expect(document.querySelector('dialog')).not.toBeNull();
			const checkbox = document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!;
			checkbox.click();
			await settle();
			expect(save).toHaveBeenCalledWith(true);
			expect(checkbox.checked).toBe(true);
		}
		document.querySelector<HTMLButtonElement>('[aria-label="Close modal"]')!.click();
		await settle();
		workspace.viewer.interactionEnabled = false;
		await settle();
		workspace.viewer.interactionEnabled = true;
		await settle();
		expect(document.querySelector('dialog')).toBeNull();
	}
);
