import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocumentResources } from '../../src/lib/document/runtime/resources.svelte';
import { createContractWorkspace } from '../../src/lib/document/runtime/workspace-factory';
import { itemStructure } from '../../src/lib/playbook/structure';
import Harness from './ViewerSnappinessHarness.svelte';
import { csmState } from './csm-state.svelte';
import { documentFixture, settle } from './snappiness-fixtures';
import { layoutFixture, render } from './document-snappiness-fixtures';
import { reactive } from './snappiness-observers.svelte';
import { documentDom } from './snappiness-dom';

let component: ReturnType<typeof mount> | undefined, dom: ReturnType<typeof documentDom>;
const cleanups: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	dom = documentDom();
});
afterEach(async () => {
	if (component) await unmount(component);
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	document.body.innerHTML = '';
	dom.destroy();
	vi.useRealTimers();
});
async function pump() {
	for (let i = 0; i < 10; i++) {
		await settle();
		await dom.frame();
		await vi.runOnlyPendingTimersAsync();
	}
}
async function fixture() {
	const data = documentFixture(20),
		layout = layoutFixture();
	// Deliberately opposite structure order: nearby reports must follow document source order.
	data.structure.items.reverse();
	const resources = new DocumentResources(layout.profiles, () => createContractWorkspace);
	cleanups.push(() => {
		resources.destroy();
		layout.destroy();
	});
	const entry = resources.acquire('admin', {
		blocks: { data: data.blocks },
		items: {},
		structure: { data: data.structure }
	});
	resources.activate(entry);
	const snapshot = await render(entry.workspace, layout);
	const report = vi.fn(),
		controls = reactive({ active: true, report: report as (ids: readonly string[]) => void });
	component = mount(Harness, {
		target: document.body,
		props: { state: csmState(), resources, workspace: entry.workspace, controls }
	});
	await pump();
	expect(entry.workspace.viewer.interactionEnabled).toBe(true);
	return { data, layout, resources, entry, snapshot, report, controls };
}

it('replays source-ordered nearby demand to a renewed preload reporter without scrolling', async () => {
	const f = await fixture();
	expect(f.report).toHaveBeenCalled();
	const nearby = f.report.mock.lastCall![0] as readonly string[];
	expect(nearby.length).toBeGreaterThan(1);
	expect(nearby.slice(0, 2)).toEqual(['item-0', 'item-1']);
	expect(nearby).toEqual(
		[...nearby].sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]))
	);
	expect(new Set(nearby).size).toBe(nearby.length);
	const renewed = vi.fn();
	f.controls.report = renewed;
	await pump();
	expect(renewed).toHaveBeenCalledExactlyOnceWith(nearby);
	expect(f.entry.workspace.renderer.snapshot).toBe(f.snapshot);
});

it('instruction-only revision updates preserve mounted page elements and schedule no new rendering work', async () => {
	const f = await fixture(),
		workspace = f.entry.workspace;
	const pages = [...document.querySelectorAll('.document-page')];
	expect(pages.length).toBeGreaterThan(1);
	const request = vi.spyOn(workspace.renderer, 'request'),
		measures = f.layout.measure.mock.calls.length;
	const updated = {
		...f.data.records[0],
		contentRevision: 2,
		instructions: { summary: 'Updated guidance' }
	};
	workspace.accept({
		blocks: { data: f.data.blocks },
		items: {},
		structure: {
			data: {
				...f.data.structure,
				authoringGeneration: 2,
				items: f.data.structure.items.map((head) =>
					head._id === updated._id ? itemStructure(updated) : head
				)
			}
		},
		details: [updated]
	});
	await pump();
	expect(workspace.source.lookup(updated._id)?.record.instructions?.summary).toBe(
		'Updated guidance'
	);
	expect(workspace.renderer.snapshot).toBe(f.snapshot);
	const currentPages = [...document.querySelectorAll('.document-page')];
	expect(currentPages).toHaveLength(pages.length);
	currentPages.forEach((page, index) => expect(page).toBe(pages[index]));
	expect(request).not.toHaveBeenCalled();
	expect(f.layout.measure).toHaveBeenCalledTimes(measures);
});

it('deactivation and reactivation reuse the same mounted pages without recomposition or profiling', async () => {
	const f = await fixture(),
		workspace = f.entry.workspace;
	const pages = [...document.querySelectorAll('.document-page')];
	const request = vi.spyOn(workspace.renderer, 'request'),
		measures = f.layout.measure.mock.calls.length;
	f.controls.active = false;
	await pump();
	f.controls.active = true;
	await pump();
	expect(workspace.viewer.interactionEnabled).toBe(true);
	expect(workspace.renderer.snapshot).toBe(f.snapshot);
	const currentPages = [...document.querySelectorAll('.document-page')];
	expect(currentPages).toHaveLength(pages.length);
	currentPages.forEach((page, index) => expect(page).toBe(pages[index]));
	expect(request).not.toHaveBeenCalled();
	expect(f.layout.measure).toHaveBeenCalledTimes(measures);
});
