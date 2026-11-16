import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Harness from './CsmHarness.svelte';
import { controlledClient, deferred } from '../../support/transport';
import { csmState } from '../../support/csm-state.svelte';
import { page, navigating, setNavigate } from '../../support/navigation.svelte';
import type { Availability } from '../../../src/lib/components/chrome/csm-availability';

const context = vi.hoisted(() => ({ client: undefined as unknown, getToken: vi.fn() }));
vi.mock('convex-svelte', () => ({ useConvexClient: () => context.client }));
vi.mock('$lib/hubspot-deals.svelte', () => ({
	useHubSpotDeals: () => ({ connection: { data: undefined, error: undefined, isLoading: true } })
}));
vi.mock('svelte-clerk', () => ({
	useClerkContext: () => ({ session: { getToken: context.getToken } })
}));
vi.mock('$lib/components/chrome/AppHeader.svelte', () => import('../../support/CsmChrome.svelte'));
vi.mock('$lib/components/chrome/AppStatus.svelte', () => import('../../support/CsmChrome.svelte'));
vi.mock(
	'$lib/components/chrome/WorkspaceSaveStatus.svelte',
	() => import('../../support/CsmChrome.svelte')
);
vi.mock('$lib/components/chrome/workspace-feedback.svelte', () => ({
	getWorkspaceFeedback: () => ({ document: null })
}));
const now = +new Date('2026-11-06T12:00:00Z');
const start = '2026-11-07T12:00:00.000Z';
const ready: Availability = {
	status: 'ready',
	slots: [{ start, end: '2026-11-07T12:30:00.000Z' }],
	duration: 30
};
let network: ReturnType<typeof controlledClient>;
let setupStatus: unknown;
let frames: Map<number, FrameRequestCallback>;
let mounted: ReturnType<typeof mount>[];
let action: ReturnType<typeof vi.fn>, mutation: ReturnType<typeof vi.fn>;
async function settle() {
	for (let i = 0; i < 8; i++) {
		flushSync();
		await tick();
		await Promise.resolve();
	}
}
async function imports() {
	await settle();
	// Let Vite resolve actual dynamic Svelte modules; assertions use events/counts, not latency.
	await vi.waitFor(() => {
		flushSync();
		if (document.querySelector('dialog[open]'))
			expect(document.querySelector('.booking:not([aria-busy=true])')).not.toBeNull();
		else expect(document.querySelector('.widget-action')).not.toBeNull();
	});
	await settle();
}
async function paint() {
	await settle();
	for (let i = 0; i < 2; i++) {
		const batch = [...frames.values()];
		frames.clear();
		for (const frame of batch) frame(0);
		await settle();
	}
}
function route(path: string) {
	page.url = new URL(path, 'https://test.local');
	page.route.id = '/(workspace)' + path;
	page.state = {};
}
function button(label: string) {
	return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
		(b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label
	)!;
}
function attach(state = csmState()) {
	const target = document.createElement('div');
	document.body.append(target);
	mounted.push(mount(Harness, { target, props: { state } }));
	return state;
}
function receipt(value: unknown) {
	network.publish('csmBookings:attempt', value);
}
function sharedSetup() {
	const status = setupStatus as { kind: string; booking?: { state: string } };
	return {
		state: status.kind === 'booking' ? (status.booking?.state ?? 'unavailable') : 'completed'
	};
}
function setup(value: unknown) {
	setupStatus = value;
	network.publish('templateUploads:status', value);
	network.publish('csmBookings:setupStatus', sharedSetup());
}
const pending = {
	filename: 'contract.docx'
};
function chooseFile() {
	const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
	Object.defineProperty(input, 'files', {
		configurable: true,
		value: [new File(['synthetic'], 'contract.docx')]
	});
	input.dispatchEvent(new Event('change', { bubbles: true }));
}
async function open() {
	await imports();
	button('Expand support widget')?.click();
	await settle();
	document.querySelector<HTMLButtonElement>('.widget-action[aria-haspopup=dialog]')!.click();
	await imports();
}
async function close() {
	button('Close modal').click();
	await settle();
}
function unresolved(state = 'unknown', error: string | null = null) {
	return {
		id: 'attempt',
		operationId: 'synthetic-operation',
		mode: 'support',
		state,
		requestedStart: start,
		start,
		timeZone: 'UTC',
		error
	};
}
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(now);
	frames = new Map();
	let frameId = 0;
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches: query.includes('1000px'),
		media: query,
		addEventListener() {},
		removeEventListener() {}
	}));
	HTMLDialogElement.prototype.showModal = function () {
		this.open = true;
	};
	HTMLDialogElement.prototype.close = function () {
		this.open = false;
	};
	setupStatus = { kind: 'booking', booking: { kind: 'initial', state: 'ready' }, pending: null };
	mounted = [];
	action = vi.fn(async () => ready);
	mutation = vi.fn(async () => null);
	network = controlledClient((observation) => {
		if (observation.name === 'templateUploads:status') observation.update(setupStatus);
		if (observation.name === 'csmBookings:setupStatus') observation.update(sharedSetup());
	});
	context.client = {
		action,
		mutation,
		connectionState: () => ({ isWebSocketConnected: false }),
		subscribeToConnectionState: () => () => {},
		onUpdate: network.onUpdate
	};
	context.getToken.mockResolvedValue('synthetic-token');
	localStorage.clear();
	route('/template');
	navigating.to = null;
	setNavigate(async (path) => {
		route(path);
	});
});
afterEach(async () => {
	for (const component of mounted) await unmount(component);
	document.body.innerHTML = '';
	vi.useRealTimers();
});
it('keeps upload help collapsed and idle until requested across revisions and route visits, including optional failure', async () => {
	const state = csmState();
	state.viewer.templateReady = false;
	action.mockRejectedValue(new Error('optional failure'));
	attach(state);
	await settle();
	expect(action).not.toHaveBeenCalled();
	await paint();
	await imports();
	expect(action).not.toHaveBeenCalled();
	expect(button('Expand support widget')).toBeDefined();
	expect(document.querySelector('dialog[open]')).toBeNull();
	button('Expand support widget').click();
	await settle();
	expect(action).toHaveBeenCalledTimes(1);
	state.revision++;
	await paint();
	expect(action).toHaveBeenCalledTimes(1);
	route('/contracts');
	await paint();
	route('/template');
	await paint();
	expect(action).toHaveBeenCalledTimes(1);
	document.querySelector('.widget-action')!.dispatchEvent(new Event('pointerenter'));
	await settle();
	expect(action).toHaveBeenCalledTimes(2);
	expect(document.querySelector('dialog[open]')).toBeNull();
});
it('waits for an unblocked owner to warm times and a fresh usable receipt to enable submission', async () => {
	const state = csmState();
	state.session.blocked = true;
	attach(state);
	await paint();
	expect(action).not.toHaveBeenCalled();
	state.session.blocked = false;
	await paint();
	await open();
	expect(action).toHaveBeenCalledTimes(1);
	const slot = document.querySelector<HTMLButtonElement>('.slot-button')!;
	expect(slot).not.toBeNull();
	expect(slot.disabled).toBe(true);
	const zone = document.querySelector<HTMLSelectElement>('select')!;
	expect(zone.disabled).toBe(true);
	zone.value = 'Europe/London';
	zone.dispatchEvent(new Event('change', { bubbles: true }));
	slot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
	expect(mutation).not.toHaveBeenCalled();
	expect(action).toHaveBeenCalledTimes(1);
	receipt(null);
	await settle();
	expect(slot.disabled).toBe(false);
	slot.click();
	await settle();
	expect(button('Book')).toBeDefined();
	await close();
	await open();
	expect(action).toHaveBeenCalledTimes(1);
	expect(document.querySelector<HTMLButtonElement>('.slot-button')!.disabled).toBe(true);
	expect(network.live('csmBookings:attempt')).toHaveLength(1);
	network.live('csmBookings:attempt')[0].error(new Error('Receipt failed'));
	await settle();
	expect(document.querySelector('.booking')!.textContent).toContain('status couldn’t load');
	expect(document.querySelector('.slot-button')).toBeNull();
});
it('initially collapsed support stays idle until opening and unresolved receipt suppresses reopen reads until failed', async () => {
	const state = csmState();
	state.viewer.company.setupCall = {
		state: 'scheduled',
		start: '2026-11-14T15:00:00Z',
		end: '2026-11-14T15:30:00Z'
	};
	attach(state);
	await paint();
	await imports();
	expect(action).not.toHaveBeenCalled();
	await open();
	expect(action).toHaveBeenCalledTimes(1);
	receipt({ ...unresolved(), mode: 'support' });
	await settle();
	await close();
	await open();
	expect(action).toHaveBeenCalledTimes(1);
	receipt({ ...unresolved('failed', 'conflict'), mode: 'support' });
	await settle();
	expect(action).toHaveBeenCalledTimes(2);
});
it.each(['/template', '/contracts/new'])(
	'books before optional upload on %s, waits durably, and opens help only on request without navigating',
	async (path) => {
		route(path);
		const state = csmState();
		state.form = true;
		state.viewer.templateReady = false;
		attach(state);
		await paint();
		await settle();
		expect(action).toHaveBeenCalledTimes(1);
		expect(action.mock.calls[0][1]).toMatchObject({ mode: 'setup' });
		expect(document.querySelector('input[type=file]')).toBeNull();
		expect(document.querySelector('dialog[open]')).toBeNull();
		receipt({ ...unresolved('booked'), mode: 'setup' });
		await settle();
		// A private success callback alone cannot reveal upload controls.
		expect(document.querySelector('input[type=file]')).toBeNull();
		state.viewer.company.setupCall = {
			state: 'scheduled',
			start: '2026-11-14T15:00:00Z',
			end: '2026-11-14T15:30:00Z'
		};
		setup({ kind: 'upload' });
		await settle();
		vi.setSystemTime(now + 120_001);
		const order: string[] = [],
			calendar = deferred<Availability>(),
			upload = deferred<Response>();
		action.mockImplementation(() => {
			order.push('calendar');
			return calendar.promise;
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				order.push('upload');
				return upload.promise;
			})
		);
		chooseFile();
		await settle();
		expect(order).toEqual(['upload']);
		upload.resolve(
			new Response(JSON.stringify({ pendingTemplateSourceId: 'templateSource', issues: [] }))
		);
		setup({ kind: 'waiting', pending });
		await settle();
		expect(document.querySelector('[aria-label="Waiting for Julien"]')!.textContent).toContain(
			'contract.docx'
		);
		expect(button('Choose another file')).toBeDefined();
		expect(mutation).not.toHaveBeenCalled();
		expect(page.url.pathname).toBe(path);
		state.viewer.templateReady = true;
		state.form = false;
		await paint();
		await imports();
		expect(document.querySelector('dialog[open]')).toBeNull();
		await open();
		calendar.resolve(ready);
		await settle();
		expect(order).toEqual(['upload', 'calendar']);
		expect(page.url.pathname).toBe(path);
	}
);
it('replaces the cache on transport change and ignores prior late work', async () => {
	const old = deferred<Availability>();
	action.mockReturnValue(old.promise);
	const state = csmState();
	state.viewer.templateReady = false;
	attach(state);
	await paint();
	await open();
	expect(action).toHaveBeenCalledTimes(1);
	state.session.transportGeneration++;
	action.mockResolvedValue(ready);
	await paint();
	expect(document.querySelector('dialog[open]')).toBeNull();
	expect(action).toHaveBeenCalledTimes(1);
	await open();
	expect(action).toHaveBeenCalledTimes(2);
	old.resolve({ ...ready, slots: [] });
	await settle();
	expect(document.querySelector('.slot-button')).not.toBeNull();
});
it('calendar failures never fail uploads and repeated uploads do not speculatively refresh help', async () => {
	route('/template');
	const state = csmState();
	state.form = true;
	state.viewer.templateReady = false;
	state.viewer.company.setupCall = {
		state: 'scheduled',
		start: '2026-11-14T15:00:00Z',
		end: '2026-11-14T15:30:00Z'
	};
	setupStatus = { kind: 'upload' };
	attach(state);
	await paint();
	await imports();
	vi.setSystemTime(now + 120_001);
	action.mockRejectedValue(new Error('optional calendar error'));
	document.querySelector('.widget-action')!.dispatchEvent(new Event('pointerenter'));
	await settle();
	expect(action).toHaveBeenCalledTimes(1);
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(JSON.stringify({ pendingTemplateSourceId: 'templateSource', issues: [] }))
		)
	);
	const upload = async () => {
		chooseFile();
		await settle();
		setup({ kind: 'waiting', pending });
		await settle();
		expect(document.querySelector('[aria-label="Waiting for Julien"]')!.textContent).toContain(
			'contract.docx'
		);
		expect(document.querySelector('[role=alert]')).toBeNull();
	};
	await upload();
	button('Choose another file').click();
	await settle();
	await upload();
	expect(action).toHaveBeenCalledTimes(1);
	expect(mutation).not.toHaveBeenCalled();
	expect(page.url.pathname).toBe('/template');
	expect(document.querySelector('dialog[open]')).toBeNull();
});
it('submission invalidates before waiting; support receipt still completes when authoritative setup booking state changes', async () => {
	const state = attach();
	await paint();
	await open();
	receipt(null);
	await settle();
	const commit = deferred<{ attemptId: string; operationId: string }>();
	mutation.mockReturnValue(commit.promise);
	document.querySelector<HTMLButtonElement>('.slot-button')!.click();
	await settle();
	button('Book').click();
	await settle();
	const args = mutation.mock.calls[0][1];
	await close();
	await open();
	expect(action).toHaveBeenCalledTimes(1);
	// Adopt the pending receipt from a fresh subscription after reopening.
	receipt({ ...unresolved('queued'), operationId: args.operationId });
	await settle();
	// A mismatched bound receipt cannot clear the advisory unresolved hint.
	receipt({ ...unresolved('failed', 'conflict'), id: 'another-attempt' });
	await settle();
	await close();
	await open();
	expect(action).toHaveBeenCalledTimes(1);
	receipt({ ...unresolved('queued'), operationId: args.operationId });
	await settle();
	state.viewer.company.setupCall = {
		state: 'scheduled',
		start: '2026-11-14T15:00:00Z',
		end: '2026-11-14T15:30:00Z'
	};
	receipt({ ...unresolved('booked'), operationId: args.operationId });
	await settle();
	expect(document.querySelector('dialog[open]')!.textContent).toContain('Your call is booked');
	commit.resolve({ attemptId: 'attempt', operationId: args.operationId });
	await settle();
	await close();
	await imports();
	button('Expand support widget').click();
	await settle();
	expect(action).toHaveBeenCalledTimes(2);
});
