import { afterEach, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { AdminAuthoringSession } from '../../src/lib/playbook/admin-authoring-session.svelte';
import { documentAnnotations } from '../../src/lib/playbook/document-overlay';
import type { SessionEditor } from '../../src/lib/auth/viewer-session.svelte';
import { ContractSourceController } from '../../src/lib/document/runtime/source.svelte';
import {
	companyId,
	controlledClient,
	documentFixture,
	membershipId,
	settle
} from './snappiness-fixtures';
import { observe } from './snappiness-observers.svelte';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(count = 12, sourceReady = true) {
	const data = documentFixture(count),
		network = controlledClient();
	let lifecycle!: SessionEditor;
	const session = new AdminAuthoringSession({
		client: network.client,
		membershipId,
		companyId,
		registerEditor: (editor) => {
			lifecycle = editor;
			return () => {};
		}
	});
	session.start();
	const source = new ContractSourceController();
	source.accept({ blocks: { data: data.blocks }, items: {}, structure: { data: data.structure } });
	const detach = session.attach(() => ({
		contract: source.compiled,
		geometry: source.geometry,
		items: source.structuralItems,
		itemsCurrent: true,
		available: sourceReady,
		lookup: (id) => {
			const record = session.detail(id);
			return record ? { record, annotations: documentAnnotations(record) } : null;
		},
		detailStatus: (id) => session.detailStatus(id)
	}));
	session.configurePreloading(data.structure.baselineFingerprint);
	network.publish('playbookItems:currentStructure', data.structure);
	cleanups.push(() => {
		session.destroy();
		source.destroy();
	});
	const open = (i: number) =>
		session.select(data.records[i]._id, documentAnnotations(data.records[i])[0].id);
	const respond = (i: number) => network.publishDetail(data.records[i]._id, data.detail(i));
	const close = () => {
		expect(session.controller.cancel()).toBe('closed');
		session.acceptSource();
	};
	return {
		data,
		network,
		session,
		source,
		open,
		respond,
		close,
		detach,
		get lifecycle() {
			return lifecycle;
		}
	};
}

it('starts eight speculative reads before the renderer is ready or a clause is clicked', () => {
	const f = fixture(20, false);
	expect(f.network.details().map((o) => o.args.id)).toEqual(
		f.data.records.slice(0, 8).map((r) => r._id)
	);
	expect(f.session.controller.entry).toBeNull();
	expect(f.network.mutation).not.toHaveBeenCalled();
});

it('opens a warmed instruction synchronously and reuses it through close and A → B → A', () => {
	const f = fixture();
	f.respond(0);
	f.respond(1);
	const reads = f.network.onUpdate.mock.calls.length;
	for (const i of [0, 1, 0]) {
		expect(f.open(i).status).toBe('accepted');
		// No tick, timer, promise or additional response is allowed between click and these assertions.
		expect(f.session.selectionRequest?.status).toBe('opened');
		expect(f.session.controller.draft?.persistedId).toBe(f.data.records[i]._id);
		expect(f.session.pendingPanel).toBeNull();
		f.close();
	}
	expect(f.network.onUpdate).toHaveBeenCalledTimes(reads);
});

it('dispatches a cold foreground read with all eight optional first responses still pending', () => {
	const f = fixture(20);
	expect(f.network.details()).toHaveLength(8);
	f.open(19);
	expect(f.network.details()).toHaveLength(9);
	expect(f.session.pendingPanel?.itemId).toBe(f.data.records[19]._id);
	f.respond(19);
	expect(f.session.controller.draft?.persistedId).toBe(f.data.records[19]._id);
	expect(f.session.selectionRequest?.status).toBe('opened');
	// None of the original eight optional responses was delivered.
	expect(f.network.details().filter((o) => o.args.id !== f.data.records[19]._id)).toHaveLength(8);
});

it('cancellation and supersession never open a late cold response', () => {
	const f = fixture(20);
	f.open(18);
	expect(f.session.cancelSelection()).toBe(true);
	f.respond(18);
	expect(f.session.controller.entry).toBeNull();
	f.open(17);
	f.open(19);
	f.respond(17);
	expect(f.session.controller.entry).toBeNull();
	f.respond(19);
	expect(f.session.controller.draft?.persistedId).toBe(f.data.records[19]._id);
});

it('a formerly warm instruction waits for its current revision rather than presenting stale content', () => {
	const f = fixture();
	f.respond(0);
	const updated = {
		...f.data.records[0],
		contentRevision: 2,
		instructions: { summary: 'Current guidance' }
	};
	f.network.publish('playbookItems:currentStructure', {
		...f.data.structure,
		authoringGeneration: 2,
		items: f.data.structure.items.map((head, i) => (i ? head : { ...head, contentRevision: 2 }))
	});
	f.open(0);
	expect(f.session.pendingPanel).not.toBeNull();
	expect(f.session.controller.entry).toBeNull();
	f.respond(0);
	expect(f.session.controller.entry).toBeNull();
	f.network.publishDetail(updated._id, { ...f.data.detail(0, updated), authoringGeneration: 2 });
	expect(f.session.pendingPanel).toBeNull();
	expect(f.session.controller.draft?.instructions.summary).toBe('Current guidance');
});

it('optional failures stay local and an explicit foreground retry can still open and remain warm', () => {
	const f = fixture(),
		failed = f.network.details()[0];
	failed.error(new Error('Speculative read failed'));
	expect(f.session.message).toBe('');
	expect(failed.released).toBe(true);
	f.open(0);
	expect(f.network.details().some((o) => o.args.id === f.data.records[0]._id)).toBe(true);
	f.respond(0);
	expect(f.session.controller.draft?.persistedId).toBe(f.data.records[0]._id);
	f.close();
	const calls = f.network.onUpdate.mock.calls.length;
	f.open(0);
	expect(f.session.selectionRequest?.status).toBe('opened');
	expect(f.network.onUpdate).toHaveBeenCalledTimes(calls);
});

it('prioritizes nearby demand, renews the reporter after same-baseline refresh, and fences retired reports', () => {
	const f = fixture(24),
		nearby = [f.data.records[20]._id, f.data.records[19]._id];
	const first = f.session.instructionPreload!;
	first(nearby);
	expect(
		f.network
			.details()
			.slice(-2)
			.map((o) => o.args.id)
	).toEqual(nearby);
	f.session.retryReads();
	expect(f.session.instructionPreload).toBeUndefined();
	f.network.publish('playbookItems:currentStructure', f.data.structure);
	const renewed = f.session.instructionPreload!;
	expect(renewed).toBeTypeOf('function');
	expect(renewed).not.toBe(first);
	renewed(nearby); // A viewer must replay the current window to each new reporter; component coverage below.
	const calls = f.network.onUpdate.mock.calls.length;
	first([f.data.records[23]._id]);
	expect(f.network.onUpdate).toHaveBeenCalledTimes(calls);
	expect(
		f.network
			.details()
			.slice(-2)
			.map((o) => o.args.id)
	).toEqual(nearby);
});

it('retains at most 64 optional records and eight awaiting reads, including warm editor demotion', () => {
	const f = fixture(90),
		answered = new Set<object>();
	for (let step = 0; step < 100; step++) {
		expect(f.network.details()).toHaveLength(Math.min(64, answered.size + 8));
		expect(f.network.details().filter((o) => !answered.has(o)).length).toBeLessThanOrEqual(8);
		const next = f.network.details().find((o) => !answered.has(o));
		if (!next) break;
		answered.add(next);
		f.respond(Number(next.args.id!.split('-')[1]));
	}
	expect(f.network.details()).toHaveLength(64);
	f.open(0);
	f.open(1);
	const editor = f.data.records[1]._id;
	expect(f.network.details().filter((o) => o.args.id !== editor).length).toBeLessThanOrEqual(64);
	f.close();
	expect(f.network.details().length).toBeLessThanOrEqual(64);
});

it('enforces the encoded-body budget without repeatedly fetching the body that exceeded it', () => {
	const f = fixture(20),
		large = 'x'.repeat(3 * 1024 * 1024);
	const retained = new Map<string, number>();
	for (const i of [0, 1]) {
		const record = { ...f.data.records[i], instructions: { summary: large } };
		retained.set(record._id, new TextEncoder().encode(JSON.stringify(record)).byteLength);
		f.network.publishDetail(record._id, f.data.detail(i, record));
	}
	const bytes = () =>
		f.network.details().reduce((sum, o) => sum + (retained.get(o.args.id!) ?? 0), 0);
	expect(bytes()).toBeGreaterThan(3 * 1024 * 1024);
	expect(bytes()).toBeLessThanOrEqual(4 * 1024 * 1024);
	const calls = f.network.onUpdate.mock.calls.length;
	for (let i = 0; i < 10; i++) f.session.acceptSource();
	expect(f.network.onUpdate).toHaveBeenCalledTimes(calls);
});

it('optional arrivals do not notify the foreground projection or reaccept document content', async () => {
	const f = fixture(),
		accept = vi.fn();
	const release = observe(
		() => f.session.hydratedDetails,
		(details) => {
			accept(details);
			f.source.accept({
				blocks: { data: f.data.blocks },
				items: {},
				structure: { data: f.data.structure },
				details
			});
		}
	);
	cleanups.push(release);
	await settle();
	const projection = f.session.hydratedDetails,
		renderSource = f.source.renderSource;
	const calls = accept.mock.calls.length;
	for (const i of [0, 1, 2, 3, 4]) f.respond(i);
	await settle();
	expect(accept).toHaveBeenCalledTimes(calls);
	expect(f.session.hydratedDetails).toBe(projection);
	expect(f.source.renderSource).toBe(renderSource);
	expect(f.source.domain.metrics.compiledContractBuilds).toBe(1);
});

it('releases speculative work on freeze and detach, and ignores callbacks from released reads', () => {
	const f = fixture(),
		old = f.network.details()[0];
	f.lifecycle.freeze(true);
	expect(f.network.details()).toHaveLength(0);
	expect(f.session.instructionPreload).toBeUndefined();
	old.update(f.data.detail(0));
	expect(f.session.detail(f.data.records[0]._id)).toBeNull();
	f.lifecycle.freeze(false);
	expect(f.network.details()).toHaveLength(8);
	f.detach();
	expect(f.network.details()).toHaveLength(0);
	expect(f.session.instructionPreload).toBeUndefined();
	f.session.destroy();
	expect(f.network.live('playbookItems:currentStructure')).toHaveLength(0);
	expect(f.network.details()).toHaveLength(0);
	flushSync();
});
