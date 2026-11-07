import { expect, vi } from 'vitest';
import { ContractLayoutProfiles } from '../../src/lib/document/runtime/layout-context.svelte';
import { createContractWorkspace } from '../../src/lib/document/runtime/workspace-factory';
import type { LayoutProfileSurface } from '../../src/lib/document/pagination/profiler';
import type { BlockLayoutProfile } from '../../src/lib/document/pagination/profile';
import type { PreparedBlock } from '../../src/lib/document/pagination/prepare';
import type { ContractWorkspace } from '../../src/lib/document/runtime/workspace-context';
import type { ConcessionSelection } from '../../src/lib/playbook/model';
import { documentFixture, settle } from './snappiness-fixtures';

/** The browser measurement boundary is synthetic; composition/pagination/caches remain real. */
export function layoutFixture() {
	const surface: LayoutProfileSurface = {
		epoch: 'synthetic-font-epoch',
		withBlock(block, _epoch, _detail, visit) {
			const profile = paragraphProfile(block);
			return visit(profile, () => profile);
		}
	};
	const measure = vi.spyOn(surface, 'withBlock');
	const profiles = new ContractLayoutProfiles();
	profiles.surface = surface;
	return { profiles, measure, destroy: () => profiles.scheduler.destroy() };
}

function paragraphProfile(block: PreparedBlock): BlockLayoutProfile {
	if (block.fragment.type !== 'paragraph')
		throw new Error('This fixture measures paragraphs only.');
	return {
		kind: 'paragraph',
		tokenCount: block.fragment.tokens.length,
		marginBlockStart: 0,
		marginBlockEnd: 0,
		contentHeight: 80,
		lines: [{ startToken: 0, endToken: block.fragment.tokens.length, top: 0, bottom: 80 }]
	};
}

export async function driveUntil(done: () => boolean) {
	for (let i = 0; i < 100; i++) {
		await settle();
		if (done()) return;
		await vi.runOnlyPendingTimersAsync();
	}
	expect(done(), 'controlled renderer/scheduler work did not finish').toBe(true);
}

export async function render(
	workspace: ContractWorkspace,
	layout: ReturnType<typeof layoutFixture>,
	concessions: ConcessionSelection = {}
) {
	const renderer = workspace.renderer;
	workspace.source.setSelection(concessions);
	renderer.request({
		source: workspace.source.renderSource!,
		concessions,
		profiler: layout.profiles.profiler!
	});
	await driveUntil(() => !renderer.pending || Boolean(renderer.error));
	expect(renderer.error).toBeNull();
	expect(renderer.snapshot).not.toBeNull();
	return renderer.snapshot!;
}

export function workspaceFixture(data = documentFixture()) {
	const layout = layoutFixture();
	const workspace = createContractWorkspace({
		blocks: { data: data.blocks },
		items: { data: data.records }
	});
	return {
		...layout,
		data,
		workspace,
		destroy() {
			workspace.renderer.destroy();
			workspace.source.destroy();
			layout.destroy();
		}
	};
}
