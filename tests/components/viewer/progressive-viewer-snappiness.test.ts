import { mount, unmount, type Snippet } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocumentResources } from '../../../src/lib/document/runtime/resources.svelte';
import { createDocumentWorkspace } from '../../../src/lib/document/runtime/workspace-factory';
import type { RenderPriority } from '../../../src/lib/document/runtime/scheduler';
import {
	DocumentHighlightController,
	getDocumentHighlights
} from '../../../src/lib/document/highlights/controller';
import * as selection from '../../../src/lib/document/selection/selection-model';
import { approvedDocumentInput } from '../../../src/lib/contract/document-preview';
import { csmState } from '../../support/csm-state.svelte';
import { documentFixture, readyContract } from '../../support/document';
import { layoutFixture } from '../../support/document-layout';
import { documentDom } from '../../support/document-dom';
import { reactive } from '../../support/observers.svelte';
import { settle } from '../../support/svelte';
import { deferred } from '../../support/transport';
import { env } from '../../support/browser-inputs';
import Harness from './ViewerSnappinessHarness.svelte';
import { buildSourceIndex } from '../../../src/lib/document/source-index';

let component: ReturnType<typeof mount> | undefined;
let dom: ReturnType<typeof documentDom>;
const cleanups: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	dom = documentDom();
	Object.assign(env, { PUBLIC_DOCUMENT_PERF: '1' });
});
afterEach(async () => {
	if (component) await unmount(component);
	component = undefined;
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	document.getSelection()?.removeAllRanges();
	document.body.innerHTML = '';
	dom.destroy();
	Reflect.deleteProperty(env, 'PUBLIC_DOCUMENT_PERF');
	vi.useRealTimers();
});
async function step() {
	await settle();
	await dom.frame();
	await vi.runOnlyPendingTimersAsync();
	await settle();
}
async function until(done: () => boolean) {
	for (let i = 0; i < 180 && !done(); i++) await step();
	expect(done(), 'controlled progressive viewer did not reach the expected state').toBe(true);
}
async function steps(count = 5) {
	for (let i = 0; i < count; i++) await step();
}
function hidden(value: boolean) {
	vi.spyOn(document, 'hidden', 'get').mockReturnValue(value);
	document.dispatchEvent(new Event('visibilitychange'));
}
function fixture(count = 70, kind: 'saved' | 'rep' | 'buyer' = 'rep', active = true) {
	const data = documentFixture(count),
		layout = layoutFixture();
	const saved = readyContract(data);
	const input =
		kind === 'saved'
			? approvedDocumentInput(saved.snapshot, saved.approved!)
			: {
					kind: 'records' as const,
					blocks: { data: data.blocks },
					items: { data: data.records }
				};
	const workspace = createDocumentWorkspace(input, kind === 'buyer' ? 'effective' : 'redline');
	const resources = new DocumentResources(layout.profiles, () => createDocumentWorkspace);
	const controls = reactive({
		active,
		retained: true,
		prepare: true,
		rank: (active ? 'foreground' : 'background') as RenderPriority,
		priority: () => controls.rank
	});
	const renderer = workspace.renderer;
	const selectionBuild = vi.spyOn(selection, 'iterateSelectionDocument');
	const commits = vi.spyOn(DocumentHighlightController.prototype, 'contentCommitted');
	const append: { count: number; visible: boolean }[] = [];
	const original = layout.profiles.scheduler.run.bind(layout.profiles.scheduler);
	let hold: ((kind: string) => boolean) | undefined;
	let fail: ((kind: string) => boolean) | undefined;
	const blocked: (() => void)[] = [];
	vi.spyOn(layout.profiles.scheduler, 'run').mockImplementation(
		(priority, work, signal, paced, kind, metrics) => {
			if (fail?.(kind ?? 'preparation'))
				return Promise.reject(new Error('Controlled layout failure'));
			const run = () =>
				original(
					priority,
					async (deadline) => {
						const result = await work(deadline);
						if (kind === 'append')
							append.push({
								count: document.querySelectorAll('.document-page').length,
								visible: workspace.viewer.pagesVisible
							});
						return result;
					},
					signal,
					paced,
					kind,
					metrics
				);
			if (!hold?.(kind ?? 'preparation')) return run();
			const gate = deferred<void>();
			blocked.push(() => gate.resolve());
			return gate.promise.then(run);
		}
	);
	cleanups.push(() => {
		blocked.splice(0).forEach((release) => release());
		renderer.destroy();
		workspace.source.destroy();
		resources.destroy();
		layout.destroy();
	});
	component = mount(Harness, {
		target: document.body,
		props: { state: csmState(), resources, workspace, controls }
	});
	return {
		data,
		layout,
		workspace,
		renderer,
		controls,
		append,
		selectionBuild,
		commits,
		hold(test: (kind: string) => boolean) {
			hold = test;
		},
		fail(test: (kind: string) => boolean) {
			fail = test;
		},
		release() {
			hold = undefined;
			fail = undefined;
			blocked.splice(0).forEach((release) => release());
		}
	};
}
function pages() {
	return [...document.querySelectorAll<HTMLElement>('.document-page')];
}
function controller() {
	return getDocumentHighlights(document.querySelector<HTMLElement>('.document-stage')!);
}

it.each(['saved', 'rep', 'buyer'] as const)(
	'%s admits three flushed exact pages together while real tail pagination is held',
	async (kind) => {
		const f = fixture(70, kind);
		f.hold((unit) => unit === 'preparation' && (f.renderer.pending?.pages.length ?? 0) >= 3);
		await until(() => f.workspace.viewer.pagesVisible);
		expect(pages()).toHaveLength(3);
		expect(f.renderer.pending?.initialBatchReady).toBe(true);
		expect(f.renderer.pending?.paginationComplete).toBe(false);
		expect(f.renderer.snapshot).toBeNull();
		expect(f.workspace.viewer.interactionEnabled).toBe(false);
		expect(f.workspace.viewer.layoutPrepared).toBe(false);
		expect(f.selectionBuild).not.toHaveBeenCalled();
		expect(f.append.slice(0, 3)).toEqual([
			{ count: 1, visible: false },
			{ count: 2, visible: false },
			{ count: 3, visible: true }
		]);
		expect(document.querySelector('[data-testid="pagination-loading"]')).toBeNull();
		expect(pages()[0].closest('[hidden]')).toBeNull();
		await until(() =>
			Boolean(
				controller() &&
				pages()
					.slice(0, 3)
					.some((page) =>
						page.querySelector(
							'.document-highlight--rep-attachment, .document-highlight--buyer-attachment'
						)
					)
			)
		);
		const earlyController = controller();
		const earlyCommits = f.commits.mock.calls.length;
		const highlightedPage = pages().find((page) =>
			page.querySelector(
				'.document-highlight--rep-attachment, .document-highlight--buyer-attachment'
			)
		)!;
		const visibleAnnotation = () =>
			highlightedPage.querySelector(
				'.document-highlight--rep-attachment, .document-highlight--buyer-attachment'
			);
		expect(visibleAnnotation()).not.toBeNull();
		expect(f.renderer.snapshot).toBeNull();
		expect(f.workspace.viewer.interactionEnabled).toBe(false);
		const first = pages();
		const range = document.createRange();
		// Keep the native selection on another page: this synthetic DOM gives every
		// paragraph on one page the same line rectangle, so selection masks its highlights.
		range.selectNodeContents(first[2].querySelector('p')!);
		document.getSelection()!.removeAllRanges();
		document.getSelection()!.addRange(range);
		const nativeStart = range.startContainer;
		f.release();
		for (let i = 0; i < 180 && !f.workspace.viewer.interactionEnabled; i++) {
			await step();
			expect(
				visibleAnnotation(),
				`early highlight disappeared after pagination step ${i}`
			).not.toBeNull();
		}
		expect(f.workspace.viewer.interactionEnabled).toBe(true);
		expect(controller()).toBe(earlyController);
		await steps(3);
		expect(
			visibleAnnotation(),
			'the completed snapshot must retain the early highlight'
		).not.toBeNull();
		expect(pages().length).toBeGreaterThan(3);
		first.forEach((page, i) => expect(pages()[i]).toBe(page));
		expect(controller()).toBe(earlyController);
		expect(document.getSelection()?.getRangeAt(0).startContainer).toBe(nativeStart);
		expect(f.selectionBuild).toHaveBeenCalledTimes(1);
		expect(f.commits.mock.calls.length).toBeGreaterThan(earlyCommits);
		const snapshot = f.renderer.snapshot,
			nodes = pages(),
			measures = f.layout.measure.mock.calls.length;
		f.controls.active = false;
		await steps();
		f.controls.active = true;
		await settle();
		expect(f.workspace.viewer.pagesVisible).toBe(true);
		expect(f.renderer.snapshot).toBe(snapshot);
		nodes.forEach((page, i) => expect(pages()[i]).toBe(page));
		expect(f.layout.measure).toHaveBeenCalledTimes(measures);
	}
);

it.each([1, 12])(
	'admits a completed short document (%i paragraphs) before full selection metadata',
	async (count) => {
		const f = fixture(count);
		f.hold((kind) => kind === 'preparation' && Boolean(f.renderer.pending?.paginationComplete));
		await until(
			() => Boolean(f.renderer.pending?.paginationComplete) && f.workspace.viewer.pagesVisible
		);
		expect(pages().length).toBeGreaterThan(0);
		expect(pages().length).toBeLessThan(3);
		expect(pages()).toHaveLength(f.renderer.pending!.pages.length);
		expect(f.renderer.snapshot).toBeNull();
		expect(controller()).toBeUndefined();
		f.release();
		await until(() => f.workspace.viewer.interactionEnabled);
		expect(f.selectionBuild).toHaveBeenCalledTimes(1);
	}
);

it('parks an outstanding visible acknowledgement without a frame and completes admitted work', async () => {
	const f = fixture();
	await until(() => (f.renderer.pending?.pages.length ?? 0) === 3);
	const generation = f.renderer.pending!.generation;
	f.controls.active = false;
	f.controls.rank = 'background';
	await settle();
	// No paint acknowledgement is supplied by the parked viewer.
	await until(() => Boolean(f.renderer.snapshot));
	expect(f.renderer.snapshot!.id).toBe(generation);
	expect(f.workspace.viewer.pagesVisible).toBe(false);
	expect(controller()).toBeUndefined();
	f.controls.active = true;
	f.controls.rank = 'foreground';
	await until(() => f.workspace.viewer.interactionEnabled);
});

it('suspends hidden-tab background work and resumes/promotes without dispatching it while hidden', async () => {
	hidden(true);
	const f = fixture(70, 'buyer', false);
	await steps();
	expect(f.layout.measure).not.toHaveBeenCalled();
	expect(pages()).toHaveLength(0);
	expect(f.renderer.snapshot).toBeNull();
	hidden(false);
	await until(() => (f.renderer.pending?.pages.length ?? 0) > 0);
	f.controls.rank = 'foreground';
	f.controls.active = true;
	await until(() => f.workspace.viewer.interactionEnabled);
	expect(f.renderer.snapshot!.pages.length).toBeGreaterThan(3);
});

it('reclassifies a visible acknowledgement on tab hide without forcing hidden background dispatch', async () => {
	const f = fixture();
	await until(() => (f.renderer.pending?.pages.length ?? 0) === 3);
	hidden(true);
	f.controls.rank = 'background';
	await settle();
	const measures = f.layout.measure.mock.calls.length;
	await steps();
	expect(f.layout.measure).toHaveBeenCalledTimes(measures);
	expect(f.renderer.snapshot).toBeNull();
	hidden(false);
	f.controls.active = false;
	await until(() => Boolean(f.renderer.snapshot));
});

it.each([1, 3])(
	'keeps threshold-aware local errors and retries after %i closed pages',
	async (count) => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const f = fixture();
		f.fail((kind) => kind === 'preparation' && (f.renderer.pending?.pages.length ?? 0) >= count);
		await until(() => Boolean(f.renderer.error));
		await steps();
		if (count === 1) {
			expect(f.workspace.viewer.pagesVisible).toBe(false);
			expect(pages()).toHaveLength(0);
			expect(document.body.textContent).toContain('We couldn’t display this document.');
		} else {
			expect(f.workspace.viewer.pagesVisible).toBe(true);
			expect(pages()).toHaveLength(3);
			expect(document.body.textContent).toContain('This document is incomplete.');
		}
		const before = pages();
		f.release();
		(document.querySelector('button') as HTMLButtonElement).click();
		await until(() => f.workspace.viewer.interactionEnabled);
		before.forEach((page, i) => expect(pages()[i]).toBe(page));
		expect(f.renderer.error).toBeNull();
	}
);

it('waits for the shared profiler and rejects stale source/generation/epoch acknowledgements', async () => {
	const f = fixture();
	const surface = f.layout.profiles.surface!;
	f.layout.profiles.surface = undefined;
	await steps();
	expect(f.renderer.pending).toBeNull();
	expect(pages()).toHaveLength(0);
	f.layout.profiles.surface = surface;
	await until(() => (f.renderer.pending?.pages.length ?? 0) === 3);
	const old = f.renderer.pending!;
	const changed = documentFixture(75);
	f.workspace.accept({
		kind: 'records',
		blocks: { data: changed.blocks },
		items: { data: changed.records }
	});
	await settle();
	const generation = f.renderer.pending!.generation;
	expect(generation).toBeGreaterThan(old.generation);
	f.renderer.acknowledgeInitialBatchPaint(old.generation, old.layoutEpoch!);
	f.renderer.acknowledgeInitialBatchPaint(generation, 'old-font-epoch');
	expect(f.renderer.snapshot).toBeNull();
	await until(() => f.workspace.viewer.interactionEnabled);
	expect(f.renderer.snapshot!.source).toBe(f.workspace.source.renderSource);
	expect(f.renderer.snapshot!.id).toBe(generation);
});

it('reports empty pagination locally instead of waiting for an impossible batch', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const f = fixture(0);
	await settle();
	f.renderer.request({
		source: { revision: 1, blocks: [], items: [], sourceIndex: buildSourceIndex([]) },
		concessions: {},
		profiler: f.layout.profiles.profiler!,
		progressive: true
	});
	await until(() => Boolean(f.renderer.error));
	expect(f.renderer.error?.cause).toBeInstanceOf(Error);
	expect((f.renderer.error?.cause as Error).message).toBe('Pagination produced no pages.');
	expect(f.renderer.snapshot).toBeNull();
	expect(f.workspace.viewer.pagesVisible).toBe(false);
	expect(document.body.textContent).toContain('We couldn’t display this document.');
	expect(pages()).toHaveLength(0);
});

it('prepares an active opening parked without a target, then reuses its mounted DOM immediately on attachment', async () => {
	const layout = layoutFixture(),
		data = documentFixture(70);
	const resources = new DocumentResources(layout.profiles, () => createDocumentWorkspace);
	const entry = resources.acquire('template', {
		kind: 'records',
		blocks: { data: data.blocks },
		items: { data: data.records }
	});
	const attachment = resources.activate(entry);
	const controls = reactive({ active: true });
	cleanups.push(() => {
		resources.destroy();
		layout.destroy();
	});
	component = mount(Harness, {
		target: document.body,
		props: { state: csmState(), resources, workspace: entry.workspace, entry, controls }
	});
	await until(() => entry.workspace.viewer.layoutPrepared);
	expect(entry.workspace.viewer.pagesVisible).toBe(false);
	expect(controller()).toBeUndefined();
	const nodes = pages(),
		snapshot = entry.workspace.renderer.snapshot,
		measures = layout.measure.mock.calls.length;
	expect(nodes.length).toBeGreaterThan(3);
	const viewport = document.createElement('div');
	const target = document.createElement('div');
	viewport.append(target);
	document.body.append(viewport);
	attachment.bind(
		{
			panelContent: (() => {}) as unknown as Snippet,
			selectedConcessions: {},
			onRemoveConcession() {},
			onSelect() {}
		},
		target,
		{ identity: Symbol('test-section'), viewport, active: true }
	);
	await settle();
	expect(entry.workspace.viewer.pagesVisible).toBe(true);
	expect(entry.workspace.renderer.snapshot).toBe(snapshot);
	nodes.forEach((page, i) => expect(pages()[i] === page).toBe(true));
	expect(layout.measure).toHaveBeenCalledTimes(measures);
});
