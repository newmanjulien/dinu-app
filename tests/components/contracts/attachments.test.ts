import type { Snippet } from 'svelte';
import { expect, it, vi } from 'vitest';
import type { DocumentLayoutProfiles } from '../../../src/lib/document/runtime/layout-context.svelte';
import { DocumentResources } from '../../../src/lib/document/runtime/resources.svelte';
import type { DocumentWorkspace } from '../../../src/lib/document/runtime/workspace-context';

it('prevents old attachments from clearing a replacement view', () => {
	const profiles = {
		profiler: undefined,
		scheduler: { wake: vi.fn() }
	} as unknown as DocumentLayoutProfiles;
	const workspace = {
		accept: vi.fn(),
		source: {},
		viewer: { ready: false, visible: false },
		renderer: { retainedPageCount: 0, destroy: vi.fn() }
	} as unknown as DocumentWorkspace;
	const resources = new DocumentResources(profiles, () => () => workspace);
	const entry = resources.acquire('contract-a', {
		kind: 'records' as const,
		blocks: { data: [] },
		items: { data: [] }
	});
	const old = resources.activate(entry, { 'item-a': 'old' });
	const current = resources.activate(entry, { 'item-a': 'new' });
	const viewport = document.createElement('div');
	const target = document.createElement('div');
	viewport.append(target);
	const section = { identity: Symbol('test-section'), viewport, active: true };
	const bindings = {
		panelContent: (() => {}) as unknown as Snippet,
		selectedConcessions: { 'item-a': 'new' },
		onRemoveConcession() {},
		onSelect() {}
	};
	current.bind(bindings, target, section);
	workspace.viewer.pagesVisible = true;
	old.update({ 'item-a': 'stale' });
	old.release();
	expect(entry.target).toBe(target);
	expect(entry.bindings).toBe(bindings);
	expect(entry.choices).toEqual({ 'item-a': 'new' });
	expect(workspace.viewer.pagesVisible).toBe(true);
	current.release();
	expect(entry.target).toBeUndefined();
	resources.destroy();
});
