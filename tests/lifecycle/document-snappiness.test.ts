import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from '../perf/browser-inputs';
import { DocumentResources } from '../../src/lib/document/runtime/resources.svelte';
import { createContractWorkspace } from '../../src/lib/document/runtime/workspace-factory';
import { prewarmSavedConcessions } from '../../src/lib/document/runtime/prewarm';
import { ContractPersistence } from '../../src/lib/contract/persistence.svelte';
import { deferred, documentFixture, readyContract, settle } from './snappiness-fixtures';
import {
	driveUntil,
	layoutFixture,
	render,
	workspaceFixture
} from './document-snappiness-fixtures';

const cleanups: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	Object.assign(env, { PUBLIC_CONTRACT_PERF: '1' });
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
		setTimeout(() => callback(performance.now()), 16)
	);
	vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	Reflect.deleteProperty(env, 'PUBLIC_CONTRACT_PERF');
	vi.useRealTimers();
});

it('reopening a retained contract reuses its source, renderer, prepared pages and profiling work', async () => {
	const data = documentFixture(20),
		layout = layoutFixture();
	const factory = vi.fn(createContractWorkspace);
	const resources = new DocumentResources(layout.profiles, () => factory);
	cleanups.push(() => {
		resources.destroy();
		layout.destroy();
	});
	const saved = readyContract(data),
		entry = resources.acquireContract(saved);
	const first = resources.activate(entry);
	const snapshot = await render(entry.workspace, layout);
	entry.workspace.viewer.layoutPrepared = true;
	const source = entry.workspace.source.renderSource,
		measures = layout.measure.mock.calls.length;
	const compiled = entry.workspace.source.compiled;
	expect(snapshot.pages.length).toBeGreaterThan(1);
	first.release();
	const reopened = resources.acquireContract(saved);
	resources.activate(reopened);
	await settle();
	expect(reopened).toBe(entry);
	expect(factory).toHaveBeenCalledTimes(1);
	expect(reopened.workspace.source.compiled).toBe(compiled);
	expect(reopened.workspace.source.renderSource).toBe(source);
	expect(reopened.workspace.renderer.snapshot).toBe(snapshot);
	expect(reopened.workspace.renderer.snapshot?.pages).toBe(snapshot.pages);
	expect(
		reopened.workspace.renderer.isCurrent({
			source: source!,
			concessions: {},
			profiler: layout.profiles.profiler!
		})
	).toBe(true);
	expect(layout.measure).toHaveBeenCalledTimes(measures);
	expect(reopened.workspace.source.domain.metrics.compiledContractBuilds).toBe(1);
});

it('a concession updates local intent and rendered wording without waiting for its save, reusing prewarmed geometry', async () => {
	const data = documentFixture(20),
		record = data.records[0];
	record.concessions[0].changes = [
		{ target: record.trigger.target, replacement: [{ kind: 'text', text: 'Alternative clause' }] }
	];
	const f = workspaceFixture(data);
	cleanups.push(f.destroy);
	const first = await render(f.workspace, f);
	const initialMeasures = f.measure.mock.calls.length;
	const cancelWarm = prewarmSavedConcessions(
		first,
		f.profiles.profiler!,
		f.workspace.renderer.artifacts!,
		record._id,
		f.workspace.renderer.paginationHistory,
		f.workspace.source.contentOverlays
	);
	cleanups.push(cancelWarm);
	await driveUntil(() => vi.getTimerCount() === 0);
	const measures = f.measure.mock.calls.length;
	expect(measures).toBeGreaterThan(initialMeasures);
	const response = deferred<never>(),
		save = vi.fn(() => response.promise),
		checkpoint = vi.fn();
	const saved = readyContract(data);
	const persistence = new ContractPersistence(saved.contract._id, saved.contract, save, checkpoint);
	cleanups.push(() => persistence.destroy());
	persistence.select(record._id, 'preferred');
	expect(persistence.choices[record._id]).toBe('preferred');
	expect(checkpoint).toHaveBeenCalled();
	await settle();
	expect(save).toHaveBeenCalledTimes(1);
	expect(persistence.inFlight).toBe(true);
	const next = await render(f.workspace, f, persistence.choices);
	expect(next.concessions[record._id]).toBe('preferred');
	expect(
		next.pages
			.flatMap((p) => p.placements)
			.flatMap((p) =>
				p.fragment.type === 'paragraph' ? p.fragment.tokens.map((t) => t.value) : []
			)
			.join('')
	).toContain('Alternative clause');
	expect(next.pages.some((page) => first.pages.includes(page))).toBe(true);
	expect(f.measure).toHaveBeenCalledTimes(measures);
	expect(persistence.inFlight).toBe(true); // The transport promise was never resolved.
});
