import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { DocumentResources } from '../../../src/lib/document/runtime/resources.svelte';
import { createDocumentWorkspace } from '../../../src/lib/document/runtime/workspace-factory';
import { ContractEditors } from '../../../src/lib/contract/editors.svelte';
import {
	getContractSnapshotCache,
	replaceContractCacheScope,
	contractCacheResources
} from '../../../src/lib/contract/snapshot-cache';
import { createCacheScope } from '../../../src/lib/contract/browser-storage';
import { HubSpotDeals } from '../../../src/lib/hubspot-deals.svelte';
import { HelpSession } from '../../../src/lib/components/ui/modal/help-session.svelte';
import Harness from './CreationRouteHarness.svelte';
import { creationState } from './creation-state.svelte';
import { csmState } from '../../support/csm-state.svelte';
import { controlledClient, deferred } from '../../support/transport';
import { documentFixture, readyContract } from '../../support/document';
import { settle } from '../../support/svelte';
import { layoutFixture } from '../../support/document-layout';
import { documentDom } from '../../support/document-dom';
import { page, screen, setNavigate } from '../../support/navigation.svelte';

const context = vi.hoisted(() => ({
	client: undefined as unknown,
	search: undefined as
		| Promise<typeof import('../../../src/lib/components/document/DocumentSearchTools.svelte')>
		| undefined,
	saved: undefined as
		Promise<typeof import('../../../src/lib/components/workspace/SavedContract.svelte')> | undefined
}));
vi.mock('../../../src/lib/components/document/document-tools', async (original) => ({
	...(await original<typeof import('../../../src/lib/components/document/document-tools')>()),
	loadDocumentSearch: () =>
		context.search ?? import('../../../src/lib/components/document/DocumentSearchTools.svelte')
}));
vi.mock('convex-svelte', () => ({
	useConvexClient: () => context.client,
	useQuery: (ref: Parameters<typeof getFunctionName>[0]) => ({
		data: getFunctionName(ref) === 'templates:currentVersion' ? { versionId: 'version' } : undefined
	})
}));
vi.mock('$lib/auth/destination-code', () => ({
	loadContractCreation: () =>
		import('../../../src/lib/components/workspace/ContractCreation.svelte'),
	loadSavedContract: () =>
		context.saved ?? import('../../../src/lib/components/workspace/SavedContract.svelte')
}));
let component: ReturnType<typeof mount> | undefined;
const cleanups: (() => void)[] = [];
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
	localStorage.clear();
	sessionStorage.clear();
	screen.home = false;
	screen.destination = { kind: 'new' };
	page.url = new URL('https://test.local/contracts/new');
	context.saved = undefined;
	context.search = undefined;
	setNavigate(async (path) => {
		page.url = new URL(path, page.url);
		if (path === '/contracts') screen.home = true;
		else screen.destination = { kind: 'saved', id: path.split('/').pop()! };
		await tick();
	});
});
afterEach(async () => {
	if (component) await unmount(component);
	component = undefined;
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	contractCacheResources.clear();
	document.body.innerHTML = '';
	document.body.style.overflow = '';
	dom.destroy();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
async function drive(done: () => boolean) {
	for (let i = 0; i < 300 && !done(); i++) {
		await settle();
		await dom.frame();
		await vi.advanceTimersByTimeAsync(16);
	}
	expect(done(), document.body.textContent ?? '').toBe(true);
}
function fixture({ shared = true, frozen = true } = {}) {
	const state = csmState(),
		controls = creationState(),
		layout = layoutFixture();
	state.viewer.helpPreferences.contract = true;
	const data = documentFixture(40),
		saved = readyContract(data);
	let liveTemplate = documentFixture(2).blocks;
	const network = controlledClient((observation) =>
		queueMicrotask(() => {
			if (observation.released) return;
			switch (observation.name) {
				case 'contracts:state':
					observation.update({ ...saved.contract, buyerName: null, requestDelivery: null });
					break;
				case 'templateSources:authoringSource':
					observation.update({ blocks: liveTemplate, templateSourceFingerprint: 'live' });
					break;
				case 'templates:frozenContent':
					if (frozen) observation.update(saved.snapshot);
					break;
			}
		})
	);
	const response = deferred<unknown>();
	const mutation = vi.fn((_ref: unknown, _args: unknown) => response.promise),
		action = vi.fn((_ref: unknown, _args: unknown) => new Promise<unknown>(() => {}));
	const preference = vi.fn((_hidden: boolean): Promise<unknown> => Promise.resolve(null));
	const client = {
		...network.client,
		mutation: (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
			getFunctionName(ref) === 'contracts:create'
				? mutation(ref, args)
				: getFunctionName(ref) === 'profiles:setHelpHidden'
					? preference((args as { hidden: boolean }).hidden)
					: Promise.resolve(null),
		action,
		connectionState: () => ({ isWebSocketConnected: true }),
		subscribeToConnectionState: () => () => {},
		onPaginatedUpdate_experimental: () => ({
			unsubscribe() {},
			getCurrentValue: () => ({ results: [], status: 'Exhausted', loadMore: () => false })
		})
	};
	context.client = client;
	replaceContractCacheScope(
		createCacheScope({
			profileId: state.viewer.profile.id,
			membershipId: state.viewer.membership.id
		})
	);
	const cache = getContractSnapshotCache(client);
	const factory = vi.fn(createDocumentWorkspace);
	const resources = shared
		? new DocumentResources(layout.profiles, () => (controls.factory.ready ? factory : undefined))
		: undefined;
	const releaseCache = resources
		? cache.subscribe(
				(data) => resources.prepare(data),
				(id) => resources.remove(id),
				(id) => resources.failedPreparation(id)
			)
		: () => {};
	const editors = new ContractEditors({
		userId: state.session.userId!,
		companyId: state.viewer.company.id,
		membershipId: state.viewer.membership.id,
		client: client as unknown as ConstructorParameters<typeof ContractEditors>[0]['client'],
		cache,
		onSaved() {},
		onDeleted() {},
		onRenamed() {},
		registerEditor: (editor) => {
			editor.resume();
			return () => {};
		}
	});
	editors.configure(true, false, 0);
	editors.start();
	cleanups.push(() => {
		releaseCache();
		editors.destroy();
		resources?.destroy();
		layout.destroy();
	});
	return {
		state,
		controls,
		layout,
		saved,
		network,
		response,
		mutation,
		preference,
		action,
		cache,
		factory,
		resources,
		editors,
		mount(deals?: HubSpotDeals) {
			component = mount(Harness, {
				target: document.body,
				props: {
					state,
					runtime: controls.runtime,
					profiles: layout.profiles,
					resources,
					editors,
					deals
				}
			});
		},
		confirm() {
			response.resolve({ status: 'created', id: saved.id, contract: saved.contract });
		},
		changeLiveTemplate() {
			liveTemplate = documentFixture(3).blocks;
			liveTemplate[0] = {
				...liveTemplate[0],
				content: [
					{
						kind: 'text',
						sourceKey: 'obsolete-live',
						text: 'NEW LIVE TEMPLATE MUST NOT BECOME SAVED WORDING'
					}
				]
			} as (typeof liveTemplate)[number];
			network.publish('templateSources:authoringSource', {
				blocks: liveTemplate,
				templateSourceFingerprint: 'changed'
			});
		}
	};
}
function submitButton() {
	return document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}
async function create() {
	await drive(() =>
		Boolean(document.querySelector('button[type="submit"]') && !submitButton().disabled)
	);
	const name = document.querySelector<HTMLInputElement>('input[autocomplete="organization"]')!;
	name.value = 'Frozen Buyer';
	name.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
	expect(document.querySelector('dialog')).not.toBeNull();
	await drive(() =>
		Boolean(
			document.querySelector('main[aria-label="Contract document"] [data-page-number]') &&
			!document
				.querySelector('main[aria-label="Contract document"]')
				?.classList.contains('invisible')
		)
	);
	expect(document.querySelector('main[aria-label="Contract document"]')?.textContent).toContain(
		'Clause 0.'
	);
	expect(submitButton().disabled).toBe(false);
	submitButton().click();
	await settle();
}

it('submits before host/factory, admits saved before frozen snapshot, then constructs one canonical document', async () => {
	context.saved = Promise.resolve(
		await import('../../../src/lib/components/workspace/SavedContract.svelte')
	);
	const f = fixture({ frozen: false });
	f.mount();
	await create();
	expect(f.mutation).toHaveBeenCalledTimes(1);
	expect(f.factory).not.toHaveBeenCalled();
	expect(f.resources!.entries).toHaveLength(0);
	f.changeLiveTemplate();
	f.confirm();
	await drive(() => f.network.live('templates:frozenContent').length === 1);
	expect(document.querySelector('dialog')).not.toBeNull();
	expect(f.editors.entries).toHaveLength(1);
	expect(f.editors.entries[0].readable).toBeUndefined();
	expect(document.body.textContent).toContain('Clause 0.');
	expect(document.body.textContent).not.toContain('NEW LIVE TEMPLATE');
	f.controls.runtime.hostReady = true;
	f.controls.factory.ready = true;
	await settle();
	expect(f.factory).not.toHaveBeenCalled();
	f.network.publish('templates:frozenContent', f.saved.snapshot);
	await drive(
		() => !document.querySelector('dialog') && Boolean(document.querySelector('[data-page-number]'))
	);
	expect(screen.destination).toEqual({ kind: 'saved', id: f.saved.id });
	expect(f.factory).toHaveBeenCalledTimes(1);
	const entry = f.resources!.entries[0];
	expect(entry.id).toBe(f.saved.id);
	expect(entry.opening).toBe(true);
	expect(document.body.textContent).toContain('Clause 0.');
	expect(document.body.textContent).not.toContain('NEW LIVE TEMPLATE');
	expect(f.editors.entries[0].snapshot).toBe(f.cache.peek(f.saved.id)!.snapshot);
	expect(entry.workspace.source.renderSource).toBeDefined();
	expect(f.network.observations.filter((o) => o.name === 'templates:frozenContent')).toHaveLength(
		1
	);
	expect(f.mutation).toHaveBeenCalledTimes(1);
});

it('prepares while saved module is held and reuses real canonical pages through pressure and attachment', async () => {
	const module =
		deferred<typeof import('../../../src/lib/components/workspace/SavedContract.svelte')>();
	context.saved = module.promise;
	const f = fixture();
	f.controls.runtime.hostReady = true;
	f.controls.factory.ready = true;
	f.mount();
	await create();
	expect(f.factory).not.toHaveBeenCalled();
	f.confirm();
	await drive(() => Boolean(f.resources!.entries[0]?.workspace.viewer.layoutPrepared));
	expect(document.querySelector('dialog')).not.toBeNull();
	const entry = f.resources!.entries[0],
		source = entry.workspace.source.renderSource,
		snapshot = entry.workspace.renderer.snapshot;
	const nodes = [
			...document.querySelectorAll(`[data-document-resource="${entry.id}"] [data-page-number]`)
		],
		measures = f.layout.measure.mock.calls.length;
	expect(nodes.length).toBeGreaterThan(3);
	expect(entry.active).toBe(false);
	expect(entry.opening).toBe(true);
	f.resources!.candidates([], 0);
	f.resources!.failedPreparation(f.saved.id);
	for (let i = 0; i < 6; i++) {
		const other = f.resources!.acquire(`pressure-${i}`, {
			kind: 'records',
			blocks: { data: [] },
			items: { data: [] }
		});
		other.completed = true;
	}
	f.resources!.candidates([], 0);
	await settle();
	expect(f.resources!.entries).toContain(entry);
	expect(f.resources!.entries.length).toBeLessThanOrEqual(4);
	module.resolve(await import('../../../src/lib/components/workspace/SavedContract.svelte'));
	await drive(
		() =>
			!document.querySelector('dialog') &&
			entry.active &&
			Boolean(entry.target?.querySelector('[data-page-number]'))
	);
	expect(entry.workspace.source.renderSource).toBe(source);
	expect(entry.workspace.renderer.snapshot).toBe(snapshot);
	expect([...entry.target!.querySelectorAll('[data-page-number]')]).toEqual(nodes);
	expect(f.layout.measure).toHaveBeenCalledTimes(measures);
	expect(
		f.factory.mock.calls.filter(([input]) => input.kind === 'records' && input.contract)
	).toHaveLength(1);
	screen.home = true;
	await settle();
	expect(entry.opening).toBe(false);
	expect(entry.active).toBe(false);
	expect(f.editors.entries).toHaveLength(0);
	f.resources!.remove(entry.id);
	expect(f.resources!.entries).not.toContain(entry);
});

it('retains confirmed id and leases through frozen/host waits without replaying creation', async () => {
	const f = fixture({ frozen: false });
	f.mount();
	await create();
	f.confirm();
	await settle();
	expect(document.querySelector('dialog')).not.toBeNull();
	expect(f.editors.entries).toHaveLength(1);
	await drive(() => f.network.live('templates:frozenContent').length > 0);
	f.network.publish('templates:frozenContent', f.saved.snapshot);
	await drive(() => screen.destination.kind === 'saved');
	expect(document.querySelector('dialog')).not.toBeNull();
	f.controls.runtime.error = 'Host unavailable';
	await drive(
		() =>
			!document.querySelector('dialog') &&
			Boolean(document.body.textContent?.includes('We couldn’t load this contract'))
	);
	expect(document.body.textContent).toContain('We couldn’t load this contract');
	f.controls.runtime.error = '';
	f.controls.runtime.hostReady = true;
	f.controls.factory.ready = true;
	await drive(() => Boolean(f.resources!.entries[0]?.workspace.viewer.layoutPrepared));
	expect(f.mutation).toHaveBeenCalledTimes(1);
	expect(f.factory).toHaveBeenCalledTimes(1);
});

it('retries a rejected frozen read with the confirmed id and lease before one canonical saved attachment', async () => {
	const f = fixture({ frozen: false });
	f.controls.runtime.hostReady = true;
	f.controls.factory.ready = true;
	f.mount();
	await create();
	const operation = f.mutation.mock.calls[0][1];
	f.changeLiveTemplate();
	f.confirm();
	await drive(() => f.network.live('templates:frozenContent').length === 1);
	const editor = f.editors.entries[0];
	const frozenRead = f.network.live('templates:frozenContent')[0];
	expect(document.querySelector('dialog')).not.toBeNull();
	expect(f.resources!.hasOpening(f.saved.id)).toBe(true);
	expect(f.factory).not.toHaveBeenCalled();
	frozenRead.error(new Error('Frozen snapshot unavailable'));
	await drive(
		() =>
			!document.querySelector('dialog') &&
			Boolean(document.body.textContent?.includes('We couldn’t load this contract'))
	);
	expect(screen.destination).toEqual({ kind: 'saved', id: f.saved.id });
	expect(frozenRead.released).toBe(true);
	expect(f.editors.entries).toEqual([editor]);
	expect(f.resources!.hasOpening(f.saved.id)).toBe(true);
	f.resources!.candidates([], 0);
	f.resources!.failedPreparation(f.saved.id);
	await settle();
	expect(f.resources!.hasOpening(f.saved.id)).toBe(true);
	expect(f.resources!.entries).toHaveLength(0);
	expect(editor.readable).toBeUndefined();
	expect(document.querySelector('[data-page-number]')).toBeNull();
	expect(document.body.textContent).not.toContain('Clause 0.');
	expect(document.body.textContent).not.toContain('NEW LIVE TEMPLATE');
	expect(f.factory).not.toHaveBeenCalled();
	expect(f.mutation).toHaveBeenCalledTimes(1);
	expect(f.mutation.mock.calls[0][1]).toBe(operation);
	expect(operation).toEqual(expect.objectContaining({ operationId: expect.any(String) }));
	[...document.querySelectorAll<HTMLButtonElement>('button')]
		.find((button) => button.textContent?.trim() === 'Try again')!
		.click();
	await drive(() => f.network.live('templates:frozenContent').length === 1);
	const retryRead = f.network.live('templates:frozenContent')[0];
	expect(retryRead).not.toBe(frozenRead);
	expect(retryRead.args).toEqual(frozenRead.args);
	expect(f.resources!.hasOpening(f.saved.id)).toBe(true);
	f.network.publish('templates:frozenContent', f.saved.snapshot);
	await drive(() => Boolean(f.resources!.entries[0]?.workspace.viewer.layoutPrepared));
	const entry = f.resources!.entries[0];
	expect(entry.id).toBe(f.saved.id);
	expect(entry.opening).toBe(true);
	expect(entry.active).toBe(true);
	expect(entry.target?.querySelectorAll('[data-page-number]').length).toBeGreaterThan(3);
	expect(document.body.textContent).toContain('Clause 0.');
	expect(document.body.textContent).not.toContain('NEW LIVE TEMPLATE');
	expect(editor.snapshot).toBe(f.cache.peek(f.saved.id)!.snapshot);
	expect(f.factory).toHaveBeenCalledTimes(1);
	expect(f.factory.mock.calls[0][0]).toEqual(
		expect.objectContaining({
			kind: 'records',
			contract: true
		})
	);
	expect(
		f.network.observations.filter((read) => read.name === 'templates:frozenContent')
	).toHaveLength(2);
	expect(f.mutation).toHaveBeenCalledTimes(1);
});

it('keeps uncertain retries on the exact operation/input and never recreates after navigation fails', async () => {
	const f = fixture();
	f.mount();
	await create();
	const args = f.mutation.mock.calls[0];
	f.response.reject(new Error('Connection lost after submission'));
	await settle();
	expect(submitButton().textContent).toContain('Retry creation');
	f.mutation.mockResolvedValueOnce({
		status: 'created',
		id: f.saved.id,
		contract: f.saved.contract
	});
	setNavigate(async () => {
		throw new Error('Navigation failed');
	});
	submitButton().click();
	await drive(() => submitButton().textContent?.includes('Open contract') === true);
	expect(f.mutation.mock.calls[1]).toEqual(args);
	expect(document.querySelector('dialog')).not.toBeNull();
	expect(f.resources!.hasOpening(f.saved.id)).toBe(true);
	setNavigate(async (path) => {
		screen.destination = { kind: 'saved', id: path.split('/').pop()! };
		await tick();
	});
	submitButton().click();
	await drive(() => screen.destination.kind === 'saved');
	expect(f.mutation).toHaveBeenCalledTimes(2);
	expect(document.querySelector('dialog')).not.toBeNull();
	expect(f.factory).not.toHaveBeenCalled();
	f.controls.runtime.hostReady = true;
	f.controls.factory.ready = true;
	await drive(() => !document.querySelector('dialog'));
});

it('keeps opening ownership through a saved-module failure and retry after admission', async () => {
	const module =
		deferred<typeof import('../../../src/lib/components/workspace/SavedContract.svelte')>();
	context.saved = module.promise;
	const f = fixture();
	f.controls.runtime.hostReady = true;
	f.controls.factory.ready = true;
	f.mount();
	await create();
	module.reject(new Error('Module unavailable'));
	f.confirm();
	await drive(
		() => document.body.textContent?.includes('We couldn’t load the contract viewer') === true
	);
	expect(document.querySelector('dialog')).toBeNull();
	await drive(() => Boolean(f.resources!.entries[0]?.workspace.viewer.layoutPrepared));
	const entry = f.resources!.entries[0];
	expect(entry.opening).toBe(true);
	context.saved = undefined;
	context.search = undefined;
	[...document.querySelectorAll<HTMLButtonElement>('button')]
		.find((button) => button.textContent?.trim() === 'Try again')!
		.click();
	await drive(() => entry.active && Boolean(entry.target?.querySelector('[data-page-number]')));
	expect(f.resources!.entries).toContain(entry);
	expect(f.factory).toHaveBeenCalledTimes(1);
	expect(f.mutation).toHaveBeenCalledTimes(1);
});

it('releases the keyed resource on authoritative rejection and reacquires only after saved retry', async () => {
	const f = fixture();
	f.controls.runtime.hostReady = true;
	f.controls.factory.ready = true;
	f.mount();
	await create();
	f.confirm();
	await drive(() => Boolean(f.resources!.entries[0]?.workspace.viewer.layoutPrepared));
	const entry = f.resources!.entries[0];
	for (const read of f.network.live('contracts:state')) read.error(new Error('Access revoked'));
	await settle();
	expect(f.resources!.entries).not.toContain(entry);
	expect(f.resources!.hasOpening(f.saved.id)).toBe(false);
	expect(
		document.querySelector('main[aria-label="Contract document"] [data-page-number]')
	).toBeNull();
	[...document.querySelectorAll<HTMLButtonElement>('button')]
		.find((button) => button.textContent?.trim() === 'Try again')!
		.click();
	await drive(() => Boolean(f.resources!.entries[0]?.workspace.viewer.layoutPrepared));
	expect(f.resources!.entries[0]).not.toBe(entry);
	expect(f.resources!.hasOpening(f.saved.id)).toBe(true);
	expect(f.mutation).toHaveBeenCalledTimes(1);
});

it('creates one local canonical viewer when shared preparation is disabled', async () => {
	const f = fixture({ shared: false, frozen: false });
	f.mount();
	await create();
	f.confirm();
	await drive(() => f.network.live('templates:frozenContent').length === 1);
	expect(document.querySelector('dialog')).not.toBeNull();
	expect(
		document.querySelector('main[aria-label="Contract document"] [data-page-number]')
	).not.toBeNull();
	f.controls.runtime.hostReady = true;
	f.network.publish('templates:frozenContent', f.saved.snapshot);
	await drive(
		() => !document.querySelector('dialog') && Boolean(document.querySelector('[data-page-number]'))
	);
	expect(screen.destination).toEqual({ kind: 'saved', id: f.saved.id });
	expect(document.body.textContent).toContain('Clause 0.');
	expect(document.querySelectorAll('[aria-label="Contract document"]')).toHaveLength(1);
	expect(f.mutation).toHaveBeenCalledTimes(1);
});

function installed(
	status: 'connected' | 'reconnect' = 'connected'
): NonNullable<HubSpotDeals['connection']['data']> {
	return {
		status,
		enabled: status === 'connected',
		configured: true,
		connectionId: 'installation' as NonNullable<HubSpotDeals['connection']['data']>['connectionId'],
		accountId: 'hubspot-account',
		installedAt: 7,
		shared: true,
		companyReadGranted: true,
		removal: null,
		quotes: {
			installationId: null,
			epoch: 0,
			installed: false,
			connected: false,
			enabled: false,
			pushEnabled: false
		}
	};
}
function picker(f: ReturnType<typeof fixture>) {
	return new HubSpotDeals({
		client: f.network.client as unknown as HubSpotDeals['options']['client'],
		membershipId: f.state.viewer.membership.id,
		connection: f.controls.connection,
		identity: () => f.state.session.preparedSessionId ?? null,
		generation: () => f.state.session.transportGeneration
	});
}
function eligibility(f: ReturnType<typeof fixture>, linkedDealIds: string[] = []) {
	const read = f.network.live('hubspotDeals:eligibility').at(-1)!;
	expect(read).toBeDefined();
	const args = read.args as unknown as {
		accountId: string;
		installedAt: number;
		requestIdentity: string;
	};
	read.update({ ...args, linkedDealIds });
	return read;
}
function dealButton() {
	return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
		(button) => button.textContent?.trim() === 'Fresh deal'
	);
}

it('keeps unknown installation lightweight and preserves installed reconnect policy and manual input focus', async () => {
	const f = fixture();
	const deals = picker(f);
	f.mount(deals);
	await settle();
	expect(document.body.textContent).toContain('Create a contract');
	expect(
		document.querySelector('input[autocomplete="organization"]')?.closest('[hidden]')
	).not.toBeNull();
	expect(submitButton().disabled).toBe(true);
	f.controls.connection.data = installed('reconnect');
	f.controls.connection.isLoading = false;
	await settle();
	expect(document.body.textContent).toContain('Choose a HubSpot deal');
	expect(document.body.textContent).toContain('Ask an admin to connect or reconnect');
	expect(submitButton().disabled).toBe(true);
	f.controls.connection.data = { ...installed(), status: 'uninstalled', enabled: false };
	await drive(() => !submitButton().disabled);
	const input = document.querySelector<HTMLInputElement>('input[autocomplete="organization"]')!;
	input.value = 'Kept name';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	input.focus();
	await settle();
	f.controls.runtime.error = 'Renderer failed';
	await settle();
	expect(document.activeElement).toBe(input);
	expect(input.value).toBe('Kept name');
	expect(submitButton().disabled).toBe(false);
	expect(f.mutation).not.toHaveBeenCalled();
});

it.each(['names-first', 'eligibility-first'] as const)(
	'requires scoped live eligibility with %s and retains the 250ms search debounce',
	async (order) => {
		const f = fixture();
		f.controls.connection.data = installed();
		f.controls.connection.isLoading = false;
		const names = deferred<{
			deals: { id: string; name: string }[];
			hasMore: boolean;
			nextCursor: null;
		}>();
		const list = vi.fn(() => names.promise);
		const deals = new HubSpotDeals({
			client: {
				onUpdate: f.network.onUpdate,
				action: list as unknown as HubSpotDeals['options']['client']['action']
			},
			membershipId: f.state.viewer.membership.id,
			connection: f.controls.connection,
			identity: () => f.state.session.preparedSessionId ?? null,
			generation: () => f.state.session.transportGeneration
		});
		const page = {
			deals: [{ id: 'deal-1', name: 'Fresh deal' }],
			hasMore: false,
			nextCursor: null
		};
		if (order === 'eligibility-first') {
			// Existing installation names may be warm; only the new live scoped observation grants action.
			list.mockResolvedValueOnce(page);
			await deals.load();
			await vi.advanceTimersByTimeAsync(45_001);
		}
		f.mount(deals);
		await settle();
		if (order === 'names-first') {
			names.resolve(page);
			await drive(() => Boolean(dealButton()));
		}
		await drive(() => f.network.live('hubspotDeals:eligibility').length > 0);
		expect(dealButton()?.disabled).toBe(true);
		const old = eligibility(f);
		await settle();
		if (order === 'eligibility-first') {
			expect(dealButton()?.disabled).toBe(false);
			names.resolve(page);
			await settle();
		}
		expect(dealButton()?.disabled).toBe(false);
		dealButton()!.click();
		await drive(() => !submitButton().disabled);
		f.controls.connection.data = { ...installed(), installedAt: 8 };
		await settle();
		expect(submitButton().disabled).toBe(true);
		old.update({
			accountId: 'hubspot-account',
			installedAt: 7,
			requestIdentity: 'stale',
			linkedDealIds: []
		});
		await settle();
		expect(submitButton().disabled).toBe(true);
		// Fresh ownership must also revalidate names and the current installation.
		await drive(() => Boolean(dealButton()));
		eligibility(f);
		await settle();
		dealButton()!.click();
		await drive(() => !submitButton().disabled);
		f.state.session.transportGeneration++;
		await settle();
		expect(submitButton().disabled).toBe(true);
		eligibility(f);
		await settle();
		expect(submitButton().disabled).toBe(false);
		[...document.querySelectorAll<HTMLButtonElement>('button')]
			.find((button) => button.textContent?.trim() === 'Change')!
			.click();
		await settle();
		const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
		const count = list.mock.calls.length;
		search.value = 'fresh';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		await vi.advanceTimersByTimeAsync(249);
		expect(list).toHaveBeenCalledTimes(count);
		await vi.advanceTimersByTimeAsync(1);
		expect(list).toHaveBeenCalledTimes(count + 1);
		expect(f.mutation).not.toHaveBeenCalled();
		await settle();
		eligibility(f);
		await settle();
		dealButton()!.click();
		await drive(() => !submitButton().disabled);
		f.action.mockResolvedValueOnce({
			status: 'created',
			id: f.saved.id,
			contract: f.saved.contract
		});
		submitButton().click();
		await drive(() => screen.destination.kind === 'saved');
		expect(document.querySelector('dialog')).not.toBeNull();
		expect(f.action).toHaveBeenCalledTimes(1);
		expect(f.action.mock.calls[0][1]).toMatchObject({
			dealId: 'deal-1',
			expectedConnectionId: 'installation',
			operationId: expect.any(String)
		});
		expect(f.factory).not.toHaveBeenCalled();
	}
);

it('owns first functioning help above saved module/host/frozen snapshot, and preserves focus and dismissal through arrival and retry', async () => {
	const f = fixture({ frozen: false });
	const search =
		deferred<typeof import('../../../src/lib/components/document/DocumentSearchTools.svelte')>();
	context.search = search.promise;
	f.state.viewer.helpPreferences.contract = false;
	screen.destination = { kind: 'saved', id: f.saved.id };
	const savedModule =
		deferred<typeof import('../../../src/lib/components/workspace/SavedContract.svelte')>();
	context.saved = savedModule.promise;
	f.mount();
	await settle();
	const modal = document.querySelector('dialog')!;
	expect(modal).not.toBeNull();
	expect(modal.textContent).toContain("Don't show this again");
	expect(modal.querySelectorAll('li').length).toBeGreaterThan(1);
	expect(document.querySelector('.document-page')).toBeNull();
	const checkbox = modal.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
	checkbox.focus();
	const write = deferred<unknown>();
	f.preference.mockImplementationOnce(() => write.promise);
	checkbox.click();
	await settle();
	expect(f.preference).toHaveBeenCalledWith(true);
	expect(checkbox.disabled).toBe(true);
	write.reject(new Error('Preference save failed'));
	await settle();
	expect(modal.textContent).toContain('Could not save your preference');
	checkbox.focus();
	savedModule.resolve(await import('../../../src/lib/components/workspace/SavedContract.svelte'));
	f.controls.runtime.hostReady = true;
	f.controls.factory.ready = true;
	f.network.publish('templates:frozenContent', f.saved.snapshot);
	await drive(() =>
		Boolean(
			f.resources?.entries.find((entry) => entry.id === f.saved.id)?.workspace.viewer
				.displayedSnapshot
		)
	);
	expect(document.querySelector('dialog')).toBe(modal);
	expect(document.activeElement).toBe(checkbox);
	modal.querySelector<HTMLButtonElement>('[aria-label="Close modal"]')!.click();
	await settle();
	expect(document.querySelector('dialog')).toBeNull();
	f.state.session.transportGeneration++;
	f.controls.runtime.error = 'Controlled host retry';
	await settle();
	f.controls.runtime.error = '';
	await settle();
	expect(document.querySelector('dialog')).toBeNull();
	search.resolve(await import('../../../src/lib/components/document/DocumentSearchTools.svelte'));
	await settle();
	const help = document.querySelector<HTMLButtonElement>('[aria-label="How Dinu works"]');
	expect(help).not.toBeNull();
	help!.click();
	await settle();
	expect(document.querySelector('dialog')).not.toBeNull();
});

it('waits for resolved preference before saved admission and makes A→B→A separate openings with fenced old writes', async () => {
	const f = fixture();
	f.state.viewer.helpPreferences.contract = undefined as unknown as boolean;
	screen.destination = { kind: 'saved', id: f.saved.id };
	const module =
		deferred<typeof import('../../../src/lib/components/workspace/SavedContract.svelte')>();
	context.saved = module.promise;
	f.mount();
	await settle();
	expect(document.querySelector('dialog')).toBeNull();
	module.resolve(await import('../../../src/lib/components/workspace/SavedContract.svelte'));
	await settle();
	expect(f.editors.entries[0].attachments).toBe(1);
	f.state.viewer.helpPreferences.contract = false;
	await settle();
	const first = document.querySelector('dialog')!;
	expect(first).not.toBeNull();
	expect(f.editors.entries[0].attachments).toBe(1);
	await drive(() => f.editors.entries[0].attachments === 2);
	expect(document.querySelector('dialog')).toBe(first);
	const staleWrite = deferred<unknown>();
	f.preference.mockImplementationOnce(() => staleWrite.promise);
	first.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
	await settle();
	screen.destination = { kind: 'saved', id: 'contract-other' };
	await settle();
	const second = document.querySelector('dialog')!;
	expect(second).not.toBe(first);
	expect(second).not.toBeNull();
	screen.destination = { kind: 'saved', id: f.saved.id };
	await settle();
	const third = document.querySelector('dialog')!;
	expect(third).not.toBe(first);
	expect(third).not.toBe(second);
	staleWrite.reject(new Error('Old opening write'));
	await settle();
	expect(third.textContent).not.toContain('Could not save');
	expect(third.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(false);
	f.state.viewer.profile.id = 'replacement-profile' as typeof f.state.viewer.profile.id;
	await settle();
	expect(document.querySelector('dialog')).not.toBe(third);
	expect(document.querySelectorAll('dialog')).toHaveLength(1);
});

it('closes naming before automatic help and never reopens it on same-opening saved-module failure/retry', async () => {
	const f = fixture();
	f.state.viewer.helpPreferences.contract = false;
	const module =
		deferred<typeof import('../../../src/lib/components/workspace/SavedContract.svelte')>();
	context.saved = module.promise;
	f.mount();
	await create();
	expect(document.querySelectorAll('dialog')).toHaveLength(1);
	expect(document.querySelector('dialog')!.textContent).not.toContain("Don't show this again");
	const counts: number[] = [];
	const observer = new MutationObserver(() =>
		counts.push(document.querySelectorAll('dialog').length)
	);
	observer.observe(document.body, { childList: true, subtree: true });
	module.reject(new Error('Saved code failure'));
	f.confirm();
	await drive(() => Boolean(document.querySelector('dialog input[type="checkbox"]')));
	expect(Math.max(...counts)).toBe(1);
	observer.disconnect();
	document.querySelector<HTMLButtonElement>('[aria-label="Close modal"]')!.click();
	await settle();
	expect(document.querySelector('dialog')).toBeNull();
	context.saved = import('../../../src/lib/components/workspace/SavedContract.svelte');
	[...document.querySelectorAll('button')]
		.find((button) => button.textContent?.trim() === 'Try again')!
		.click();
	await settle();
	expect(document.querySelector('dialog')).toBeNull();
	expect(f.mutation).toHaveBeenCalledTimes(1);
});

it('handles hidden preference once, fences transport-old writes, and confirms checkbox through the subscription', async () => {
	const f = fixture();
	screen.destination = { kind: 'saved', id: f.saved.id };
	context.saved = import('../../../src/lib/components/workspace/SavedContract.svelte');
	f.mount();
	await settle();
	expect(document.querySelector('dialog')).toBeNull();
	f.state.viewer.helpPreferences.contract = false;
	await settle();
	expect(document.querySelector('dialog')).toBeNull();
	// A true replacement opening gets a fresh automatic decision.
	screen.destination = { kind: 'saved', id: 'contract-other' };
	await settle();
	const modal = document.querySelector('dialog')!;
	const checkbox = modal.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
	const oldWrite = deferred<unknown>();
	f.preference.mockImplementationOnce(() => oldWrite.promise);
	checkbox.click();
	await settle();
	expect(checkbox.disabled).toBe(true);
	f.state.session.transportGeneration++;
	await settle();
	expect(checkbox.disabled).toBe(false);
	oldWrite.reject(new Error('Old transport'));
	await settle();
	expect(modal.textContent).not.toContain('Could not save');
	checkbox.click();
	await settle();
	expect(checkbox.checked).toBe(false);
	f.state.viewer.helpPreferences.contract = true;
	await settle();
	expect(checkbox.checked).toBe(true);
	expect(document.querySelector('dialog')).toBe(modal);
});

it.each(['automatic', 'manual'] as const)(
	'closes %s saved Help on hold, releases its scroll lock and retains the opening and document owners',
	async (opening) => {
		const configured = vi.spyOn(HelpSession.prototype, 'configure');
		const f = fixture();
		f.state.viewer.helpPreferences.contract = opening === 'manual';
		f.controls.runtime.hostReady = true;
		f.controls.factory.ready = true;
		screen.destination = { kind: 'saved', id: f.saved.id };
		document.body.style.overflow = 'scroll';
		f.mount();
		await drive(() => Boolean(document.querySelector('[aria-label="How Dinu works"]')));
		await drive(() => Boolean(f.resources!.entries[0]?.workspace.viewer.layoutPrepared));
		const help = configured.mock.contexts[0] as HelpSession;
		const editor = f.editors.entries[0],
			entry = f.resources!.entries[0],
			snapshot = entry.workspace.renderer.snapshot,
			pages = [...entry.target!.querySelectorAll('[data-page-number]')],
			attachments = editor.attachments,
			measures = f.layout.measure.mock.calls.length;
		expect(help.admitted).toBe(true);
		if (opening === 'manual') {
			expect(document.querySelector('dialog')).toBeNull();
			document.querySelector<HTMLButtonElement>('[aria-label="How Dinu works"]')!.click();
			await settle();
		}
		const modal = document.querySelector('dialog')!;
		const checkbox = modal.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		expect(modal.open).toBe(true);
		expect(document.body.style.overflow).toBe('hidden');
		f.controls.runtime.paused = true;
		f.state.viewer.company.deletion = { status: 'deleting', ownedByViewer: true };
		// Exercise the synchronous current() fence before the activity effect can run.
		await help.setHidden(!help.hidden);
		expect(f.preference).not.toHaveBeenCalled();
		await settle();
		expect(document.querySelector('dialog')).toBeNull();
		expect(modal.open).toBe(false);
		expect(document.body.style.overflow).toBe('scroll');
		checkbox.click();
		help.considerAutomatic();
		help.openManually();
		await help.setHidden(!help.hidden);
		await settle();
		expect(help.open).toBe(false);
		expect(help.admitted).toBe(true);
		expect(f.preference).not.toHaveBeenCalled();
		expect(document.querySelector('dialog')).toBeNull();
		expect(f.editors.entries).toEqual([editor]);
		expect(editor.attachments).toBe(attachments);
		expect(f.resources!.entries).toContain(entry);
		expect(entry.opening).toBe(true);
		f.controls.runtime.paused = false;
		f.state.viewer.company.deletion = null;
		await settle();
		expect(document.querySelector('dialog')).toBeNull();
		expect(configured.mock.contexts.every((session) => session === help)).toBe(true);
		expect(editor.attachments).toBe(attachments);
		expect(entry.workspace.renderer.snapshot).toBe(snapshot);
		expect([...entry.target!.querySelectorAll('[data-page-number]')]).toEqual(pages);
		expect(f.factory).toHaveBeenCalledTimes(1);
		expect(f.layout.measure).toHaveBeenCalledTimes(measures);
		await drive(() => Boolean(document.querySelector('[aria-label="How Dinu works"]')));
		document.querySelector<HTMLButtonElement>('[aria-label="How Dinu works"]')!.click();
		await settle();
		const resumed = document.querySelector('dialog')!;
		expect(resumed).not.toBeNull();
		expect(resumed).not.toBe(modal);
		expect(resumed.open).toBe(true);
		resumed.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
		await settle();
		expect(f.preference).toHaveBeenCalledTimes(1);
	}
);

it.each([
	{ preference: 'known', hidden: false },
	{ preference: 'unresolved', hidden: false },
	{ preference: 'known', hidden: true },
	{ preference: 'unresolved', hidden: true }
])(
	'defers initially paused $preference preference (hidden=$hidden) until the first active decision before saved admission',
	async ({ preference, hidden }) => {
		const f = fixture({ frozen: false });
		f.state.viewer.helpPreferences.contract =
			preference === 'known' ? hidden : (undefined as unknown as boolean);
		f.controls.runtime.paused = true;
		f.controls.runtime.hostReady = true;
		f.state.viewer.company.deletion = { status: 'deleting', ownedByViewer: true };
		screen.destination = { kind: 'saved', id: f.saved.id };
		context.saved = Promise.resolve(
			await import('../../../src/lib/components/workspace/SavedContract.svelte')
		);
		const configured = vi.spyOn(HelpSession.prototype, 'configure');
		const automatic = HelpSession.prototype.considerAutomatic;
		const decisions: { attachments: number | undefined; open: boolean }[] = [];
		vi.spyOn(HelpSession.prototype, 'considerAutomatic').mockImplementation(function (
			this: HelpSession
		) {
			const admitted = this.admitted;
			automatic.call(this);
			if (!admitted && this.admitted)
				decisions.push({ attachments: f.editors.entries[0]?.attachments, open: this.open });
		});
		f.mount();
		await settle();
		const help = configured.mock.contexts[0] as HelpSession;
		const editor = f.editors.entries[0];
		expect(help.admitted).toBe(false);
		expect(editor.attachments).toBe(1);
		expect(document.querySelector('dialog')).toBeNull();
		expect(document.querySelector('nav[aria-label="Document tools"]')).toBeNull();
		f.state.viewer.helpPreferences.contract = hidden;
		await settle();
		expect(help.resolved).toBe(true);
		expect(help.admitted).toBe(false);
		expect(decisions).toEqual([]);
		expect(editor.attachments).toBe(1);
		help.considerAutomatic();
		help.openManually();
		await help.setHidden(!hidden);
		await settle();
		expect(help.open).toBe(false);
		expect(f.preference).not.toHaveBeenCalled();
		f.controls.runtime.paused = false;
		f.state.viewer.company.deletion = null;
		await settle();
		expect(decisions).toEqual([{ attachments: 1, open: !hidden }]);
		expect(help.admitted).toBe(true);
		expect(editor.attachments).toBe(hidden ? 2 : 1);
		expect(Boolean(document.querySelector('dialog'))).toBe(!hidden);
		if (!hidden) {
			expect(document.querySelector('dialog')!.open).toBe(true);
			await drive(() => editor.attachments === 2);
			document.querySelector<HTMLButtonElement>('[aria-label="Close modal"]')!.click();
			await settle();
		}
		// A hidden decision is consumed too: a later subscription cannot interrupt the viewer.
		f.state.viewer.helpPreferences.contract = !hidden;
		f.state.session.transportGeneration++;
		f.controls.runtime.paused = true;
		await settle();
		expect(editor.attachments).toBe(2);
		f.controls.runtime.paused = false;
		await settle();
		expect(document.querySelector('dialog')).toBeNull();
		expect(decisions).toHaveLength(1);
		expect(configured.mock.contexts.every((session) => session === help)).toBe(true);
		expect(f.editors.entries).toEqual([editor]);
		expect(f.resources!.hasOpening(f.saved.id)).toBe(true);
	}
);

it.each(['resolve', 'reject'] as const)(
	'ignores a pre-hold preference %s after resume and a newer actual request, retaining subscription authority',
	async (completion) => {
		const configured = vi.spyOn(HelpSession.prototype, 'configure');
		const f = fixture();
		f.state.viewer.helpPreferences.contract = false;
		f.controls.runtime.hostReady = true;
		f.controls.factory.ready = true;
		screen.destination = { kind: 'saved', id: f.saved.id };
		f.mount();
		await drive(() => Boolean(document.querySelector('[aria-label="How Dinu works"]')));
		const help = configured.mock.contexts[0] as HelpSession;
		const old = deferred<unknown>(),
			current = deferred<unknown>();
		f.preference.mockImplementationOnce(() => old.promise);
		document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!.click();
		await settle();
		expect(f.preference).toHaveBeenCalledTimes(1);
		expect(help.pending).toBe(true);
		f.controls.runtime.paused = true;
		await settle();
		expect(document.querySelector('dialog')).toBeNull();
		expect(help.pending).toBe(false);
		expect(help.error).toBe('');
		f.controls.runtime.paused = false;
		await settle();
		expect(document.querySelector('dialog')).toBeNull();
		await drive(() => Boolean(document.querySelector('[aria-label="How Dinu works"]')));
		document.querySelector<HTMLButtonElement>('[aria-label="How Dinu works"]')!.click();
		await settle();
		const modal = document.querySelector('dialog')!;
		const checkbox = modal.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		expect(checkbox.checked).toBe(false);
		f.preference.mockImplementationOnce(() => current.promise);
		checkbox.click();
		await settle();
		expect(f.preference).toHaveBeenCalledTimes(2);
		expect(help.pending).toBe(true);
		expect(checkbox.disabled).toBe(true);
		if (completion === 'resolve') old.resolve(null);
		else old.reject(new Error('Pre-hold preference failed'));
		await settle();
		expect(help.pending).toBe(true);
		expect(checkbox.disabled).toBe(true);
		expect(help.error).toBe('');
		expect(modal.textContent).not.toContain('Could not save');
		expect(help.hidden).toBe(false);
		expect(checkbox.checked).toBe(false);
		current.resolve(null);
		await settle();
		expect(help.pending).toBe(false);
		expect(checkbox.disabled).toBe(false);
		expect(help.hidden).toBe(false);
		expect(checkbox.checked).toBe(false);
		f.state.viewer.helpPreferences.contract = true;
		await settle();
		expect(help.hidden).toBe(true);
		expect(checkbox.checked).toBe(true);
		expect(document.querySelector('dialog')).toBe(modal);
		expect(configured.mock.contexts.every((session) => session === help)).toBe(true);
	}
);
