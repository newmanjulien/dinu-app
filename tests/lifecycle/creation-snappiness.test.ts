import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocumentResources } from '../../src/lib/document/runtime/resources.svelte';
import { createContractWorkspace } from '../../src/lib/document/runtime/workspace-factory';
import Harness from './CreationSnappinessHarness.svelte';
import { csmState } from './csm-state.svelte';
import { deferred, documentFixture, readyContract, settle } from './snappiness-fixtures';
import { layoutFixture, render } from './document-snappiness-fixtures';

const context = vi.hoisted(() => ({ client: undefined as unknown, cache: undefined as unknown }));
vi.mock('convex-svelte', () => ({
	useConvexClient: () => context.client,
	useQuery: () => ({ data: { versionId: 'version' } })
}));
vi.mock('$lib/contract/snapshot-cache', async (importOriginal) => ({
	...(await importOriginal<object>()),
	getContractSnapshotCache: () => context.cache
}));
let component: ReturnType<typeof mount> | undefined;
const cleanups: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
		setTimeout(() => callback(performance.now()), 16)
	);
	vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(async () => {
	if (component) await unmount(component);
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	document.body.innerHTML = '';
	vi.useRealTimers();
});

it('Create adopts the prepared preview without another template load, workspace construction or pagination', async () => {
	const data = documentFixture(20),
		saved = readyContract(data),
		layout = layoutFixture();
	const factory = vi.fn(createContractWorkspace),
		resources = new DocumentResources(layout.profiles, () => factory);
	cleanups.push(() => {
		resources.destroy();
		layout.destroy();
	});
	const response = deferred<unknown>(),
		opened = deferred<boolean>();
	const mutation = vi.fn(() => response.promise),
		onOpen = vi.fn(() => opened.promise);
	const cache = {
		loadVersion: vi.fn(async () => saved.snapshot),
		seedConfirmed: vi.fn((value) => value),
		isDeleted: () => false
	};
	context.cache = cache;
	context.client = { mutation };
	component = mount(Harness, {
		target: document.body,
		props: { state: csmState(), resources, onOpen }
	});
	await settle();
	expect(cache.loadVersion).toHaveBeenCalledTimes(1);
	expect(resources.entries).toHaveLength(1);
	const draft = resources.entries[0],
		snapshot = await render(draft.workspace, layout);
	draft.workspace.viewer.layoutPrepared = true; // Simulated viewer acknowledgement after real controlled rendering.
	const source = draft.workspace.source.renderSource,
		measures = layout.measure.mock.calls.length;
	const button = document.querySelector<HTMLButtonElement>('button')!;
	button.click();
	await settle();
	expect(button.disabled).toBe(true);
	expect(mutation).toHaveBeenCalledTimes(1);
	response.resolve({ status: 'created', id: saved.id, contract: saved.contract });
	await settle();
	expect(onOpen).toHaveBeenCalledExactlyOnceWith(saved.id);
	expect(cache.loadVersion).toHaveBeenCalledTimes(1);
	expect(cache.seedConfirmed).toHaveBeenCalledExactlyOnceWith(saved);
	expect(factory).toHaveBeenCalledTimes(1);
	expect(resources.entries).toEqual([draft]);
	expect(draft.id).toBe(saved.id);
	expect(draft.workspace.source.renderSource).toBe(source);
	expect(draft.workspace.renderer.snapshot).toBe(snapshot);
	expect(draft.workspace.renderer.snapshot?.pages).toBe(snapshot.pages);
	expect(layout.measure).toHaveBeenCalledTimes(measures);
	opened.resolve(true);
	await settle();
});
