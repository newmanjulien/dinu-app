import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Harness from './CsmHarness.svelte';
import { csmState } from './csm-state.svelte';
import { page, navigating, setNavigate } from './navigation.svelte';
import type { Availability } from '../../src/lib/components/chrome/csm-availability';

const context = vi.hoisted(() => ({ client: undefined as unknown, getToken: vi.fn() }));
vi.mock('convex-svelte', () => ({ useConvexClient: () => context.client }));
vi.mock('svelte-clerk', () => ({
	useClerkContext: () => ({ session: { getToken: context.getToken } })
}));
vi.mock('$lib/components/chrome/AppHeader.svelte', () => import('./CsmChrome.svelte'));
vi.mock('$lib/components/chrome/AppStatus.svelte', () => import('./CsmChrome.svelte'));
vi.mock('$lib/components/chrome/WorkspaceSaveStatus.svelte', () => import('./CsmChrome.svelte'));
vi.mock('$lib/components/chrome/workspace-feedback.svelte', () => ({
	getWorkspaceFeedback: () => ({ document: null })
}));
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const now = +new Date('2026-11-06T12:00:00Z');
const start = '2026-11-07T12:00:00.000Z';
const ready: Availability = {
	status: 'ready',
	slots: [{ start, end: '2026-11-07T12:30:00.000Z' }],
	duration: 30,
	lastDate: null
};
type Observation = {
	args: { attemptId?: string };
	row: (value: unknown) => void;
	error: () => void;
	released: boolean;
};
let observations: Observation[];
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
		if (document.querySelector('dialog')) expect(document.querySelector('.booking')).not.toBeNull();
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
	page.route.id = path === '/' ? '/(workspace)' : '/(workspace)' + path;
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
	observations.filter((o) => !o.released).forEach((o) => o.row(value));
}
async function open(mode: 'setup' | 'support' = 'setup') {
	await imports();
	const label =
		mode === 'setup' ? "We'll take care of it — delegate" : "We're here to help — get support";
	button(label).click();
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
		mode: 'setup',
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
	observations = [];
	mounted = [];
	action = vi.fn(async () => ready);
	mutation = vi.fn(async () => null);
	context.client = {
		action,
		mutation,
		onUpdate: vi.fn((_query, args, row, error) => {
			const o = { args, row, error, released: false };
			observations.push(o);
			return () => {
				o.released = true;
			};
		})
	};
	context.getToken.mockResolvedValue('synthetic-token');
	localStorage.clear();
	route('/admin');
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
it('warms setup only after primary paint, before a baseline, once per route visit despite revisions/failure', async () => {
	const state = csmState();
	state.viewer.templateReady = false;
	action.mockRejectedValue(new Error('optional failure'));
	attach(state);
	await settle();
	expect(action).not.toHaveBeenCalled();
	await paint();
	expect(action).toHaveBeenCalledTimes(1);
	state.revision++;
	await paint();
	expect(action).toHaveBeenCalledTimes(1);
	route('/');
	await paint();
	route('/admin');
	await paint();
	expect(action).toHaveBeenCalledTimes(2);
	expect(document.querySelector('.widget-action')).toBeNull();
});
it.each(['support', 'rep', 'unsafe'] as const)('does not automatically warm %s', async (kind) => {
	const state = csmState();
	if (kind === 'support') state.viewer.company.csmCallBooked = true;
	if (kind === 'rep') {
		state.viewer.membership.role = 'rep';
		state.viewer.permissions.manageTemplate = false;
	}
	if (kind === 'unsafe') state.session.blocked = true;
	attach(state);
	await paint();
	expect(action).not.toHaveBeenCalled();
});
it('paints warmed times before receipt but blocks controls and submission until a fresh usable receipt', async () => {
	attach();
	await paint();
	await open();
	expect(action).toHaveBeenCalledTimes(1);
	const slot = document.querySelector<HTMLButtonElement>('.slot-button')!;
	expect(slot).not.toBeNull();
	expect(slot.disabled).toBe(true);
	button('Next month').click();
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
	expect(observations.filter((o) => !o.released)).toHaveLength(1);
	observations.find((o) => !o.released)!.error();
	await settle();
	expect(document.querySelector('.booking')!.textContent).toContain('status couldn’t load');
	expect(document.querySelector('.slot-button')).toBeNull();
});
it.each(['setup', 'support'] as const)(
	'explicit %s expansion warms before open, preserves focus, and retries expired data',
	async (mode) => {
		const state = csmState();
		state.viewer.company.csmCallBooked = mode === 'support';
		// No automatic setup route warming on the home route; setup widget appears on admin afterward.
		localStorage.setItem('dinu:csm-widget-dismissed', 'true');
		attach(state);
		await paint();
		await imports();
		if (mode === 'setup') vi.setSystemTime(now + 120_001);
		const pending = deferred<Availability>();
		action.mockReturnValue(pending.promise);
		const before = action.mock.calls.length;
		button(mode === 'setup' ? 'Expand delegation widget' : 'Expand support widget').click();
		await settle();
		expect(action).toHaveBeenCalledTimes(before + 1);
		expect(document.activeElement?.getAttribute('aria-haspopup')).toBe('dialog');
		await open(mode);
		expect(action).toHaveBeenCalledTimes(before + 1);
		pending.resolve(ready);
		await settle();
		expect(document.querySelector('.slot-button')).not.toBeNull();
	}
);
it('restored expanded support stays idle until opening and unresolved receipt suppresses reopen reads until failed', async () => {
	const state = csmState();
	state.viewer.company.csmCallBooked = true;
	attach(state);
	await paint();
	await imports();
	expect(action).not.toHaveBeenCalled();
	await open('support');
	expect(action).toHaveBeenCalledTimes(1);
	receipt({ ...unresolved(), mode: 'support' });
	await settle();
	await close();
	await open('support');
	expect(action).toHaveBeenCalledTimes(1);
	receipt({ ...unresolved('failed', 'conflict'), mode: 'support' });
	await settle();
	expect(action).toHaveBeenCalledTimes(2);
});
it.each(['/admin', '/contracts/new'])(
	'uploads on %s dispatch first and share times through Continue→navigation→open',
	async (path) => {
		route(path);
		const state = csmState();
		state.form = true;
		state.viewer.templateReady = false;
		attach(state);
		await paint();
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
		const file = new File(['synthetic'], 'contract.docx');
		const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
		Object.defineProperty(input, 'files', { configurable: true, value: [file] });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(order).toEqual(['upload', 'calendar']);
		upload.resolve(new Response(JSON.stringify({ preparedBaselineId: 'baseline', issues: [] })));
		await settle();
		button('Go to last step').click();
		await settle();
		expect(mutation).toHaveBeenCalledTimes(1);
		expect(page.url.pathname).toBe('/admin');
		state.viewer.templateReady = true;
		state.form = false;
		await paint();
		calendar.resolve(ready);
		await imports();
		// Continue's onboarding handoff may already have opened the modal in production.
		await open();
		expect(order).toEqual(['upload', 'calendar']);
	}
);
it('replaces the cache on transport change and ignores prior late work', async () => {
	const old = deferred<Availability>();
	action.mockReturnValue(old.promise);
	const state = attach();
	await paint();
	expect(action).toHaveBeenCalledTimes(1);
	state.session.transportGeneration++;
	action.mockResolvedValue(ready);
	await paint();
	expect(action).toHaveBeenCalledTimes(2);
	old.resolve({ ...ready, slots: [] });
	await settle();
	await open();
	expect(document.querySelector('.slot-button')).not.toBeNull();
});
it('calendar failures never fail uploads and repeated file uploads have one speculative refresh per owner', async () => {
	route('/contracts/new');
	const state = csmState();
	state.form = true;
	state.viewer.templateReady = false;
	attach(state);
	await paint();
	action.mockRejectedValue(new Error('optional calendar error'));
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify({ preparedBaselineId: 'baseline', issues: [] })))
	);
	const upload = async () => {
		const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
		Object.defineProperty(input, 'files', {
			configurable: true,
			value: [new File(['synthetic'], 'contract.docx')]
		});
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(button('Go to last step')).toBeDefined();
		expect(document.querySelector('[role=alert]')).toBeNull();
	};
	await upload();
	button('Start again').click();
	await settle();
	await upload();
	expect(action).toHaveBeenCalledTimes(1);
	button('Go to last step').click();
	await settle();
	expect(mutation).toHaveBeenCalledTimes(1);
	expect(page.url.pathname).toBe('/admin');
	expect(action).toHaveBeenCalledTimes(2);
});
it('submission invalidates before waiting; booked receipt still completes after the company promotes to support', async () => {
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
	state.viewer.company.csmCallBooked = true;
	receipt({ ...unresolved('booked'), operationId: args.operationId });
	await settle();
	expect(document.querySelector('dialog')!.textContent).toContain('Your call is booked');
	commit.resolve({ attemptId: 'attempt', operationId: args.operationId });
	await settle();
	await close();
	await imports();
	button('Expand support widget').click();
	await settle();
	expect(action).toHaveBeenCalledTimes(2);
});
