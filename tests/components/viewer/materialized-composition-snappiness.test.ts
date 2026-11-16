import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContractDocumentCompositionEngine } from '../../../src/lib/document/contract-compose';
import { CompositionArtifactStore } from '../../../src/lib/document/composition-artifacts';
import {
	applyDocumentChange,
	createContractDocument,
	prepareDocumentChange,
	type ContractDocument
} from '../../../src/lib/document/contract-document';
import type { CompositionInput } from '../../../src/lib/document/compose';
import type { ResolvedBlock, SourceBlock } from '../../../src/lib/document/model';
import { DocumentArtifacts } from '../../../src/lib/document/runtime/artifacts';
import { createDocumentWorkspace } from '../../../src/lib/document/runtime/workspace-factory';
import type { DocumentRenderSource } from '../../../src/lib/document/runtime/types';
import type { RenderPerfSample } from '../../../src/lib/document/runtime/render-perf';
import { buildSourceIndex } from '../../../src/lib/document/source-index';
import { DocumentSpacing } from '../../../src/lib/document/format';
import { env } from '../../support/browser-inputs';
import { documentFixture } from '../../support/document';
import { layoutFixture, render } from '../../support/document-layout';

const cleanups: (() => void)[] = [];
const input: CompositionInput = { items: [], activeConcessions: {}, view: 'redline' };
const paragraphs = (blocks: readonly ResolvedBlock[]) =>
	blocks.filter((b) => b.kind === 'paragraph');
const text = (blocks: readonly ResolvedBlock[], revision?: 'added' | 'removed') =>
	paragraphs(blocks)
		.map((b) =>
			b.content
				.filter((r) => revision === undefined || r.revision === revision)
				.map((r) => r.text)
				.join('')
		)
		.join('\n');

function source(
	document: ContractDocument,
	baseline: readonly SourceBlock[]
): DocumentRenderSource {
	return {
		revision: 1,
		blocks: document.blocks,
		items: [],
		sourceIndex: buildSourceIndex(document.blocks),
		materialized: { document, baseline }
	};
}
function compose(artifacts: DocumentArtifacts, value = input) {
	const request = artifacts.composition.createRequest();
	try {
		const engine = artifacts.createComposer();
		const blocks = [...engine.iterate(value, request)].filter((b): b is ResolvedBlock =>
			Boolean(b)
		);
		artifacts.composition.retain(blocks);
		return { blocks, engine };
	} finally {
		request.release();
	}
}
function pressure(store: CompositionArtifactStore) {
	const request = store.createRequest();
	try {
		for (let i = 0; i < 1024; i++) request.putRuns(`optional:${i}`, [{ text: `Optional ${i}` }]);
		expect(request.getRuns('optional:0')).toBeDefined(); // Working roots also survive trim.
	} finally {
		request.release();
	}
	const probe = store.createRequest();
	try {
		expect(probe.getRuns('optional:0')).toBeUndefined();
		expect(probe.getRuns('optional:1023')).toBeDefined();
	} finally {
		probe.release();
	}
	expect(store.capacity).toBe(256);
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.assign(env, { PUBLIC_DOCUMENT_PERF: '1' });
	Reflect.deleteProperty(window, '__documentRenderPerf');
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
		setTimeout(() => callback(performance.now()), 16)
	);
	vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	Reflect.deleteProperty(env, 'PUBLIC_DOCUMENT_PERF');
	vi.useRealTimers();
});

it.each(['effective', 'redline'] as const)(
	'retains real materialized %s preparation and pages beyond the optional artifact budget',
	async (view) => {
		const baseline = documentFixture(300).blocks;
		const document = createContractDocument(baseline);
		const layout = layoutFixture();
		const workspace = createDocumentWorkspace(
			{
				kind: 'overlays',
				contract: true,
				materialized: { data: { document, baseline } },
				overlays: []
			},
			view
		);
		cleanups.push(() => {
			workspace.renderer.destroy();
			workspace.source.destroy();
			layout.destroy();
		});
		const first = await render(workspace, layout);
		const artifacts = workspace.renderer.artifacts!;
		const current = compose(artifacts, { ...input, view });
		expect(current.engine).toBeInstanceOf(ContractDocumentCompositionEngine);
		expect(current.blocks).toHaveLength(300);
		expect(first.pages.length).toBeGreaterThan(3);
		const preparations = artifacts.createPreparation(),
			spacing = new DocumentSpacing();
		const prepared = current.blocks.map((b) => preparations.prepare(b, spacing));
		expect(preparations.preparedCount).toBe(0);
		expect(preparations.reusedCount).toBe(300);
		const measurements = layout.measure.mock.calls.length;
		pressure(artifacts.composition);
		const repeated = compose(artifacts, { ...input, view });
		expect(repeated.engine.recomposedBlocks).toBe(0);
		repeated.blocks.forEach((b, i) => expect(b).toBe(current.blocks[i]));
		const nextPreparation = artifacts.createPreparation(),
			nextSpacing = new DocumentSpacing();
		repeated.blocks.forEach((b, i) =>
			expect(nextPreparation.prepare(b, nextSpacing)).toBe(prepared[i])
		);
		expect(nextPreparation.preparedCount).toBe(0);
		const next = await render(workspace, layout);
		expect(next).not.toBe(first); // A real second renderer request ran.
		next.pages.forEach((page, i) => expect(page).toBe(first.pages[i]));
		expect(layout.measure).toHaveBeenCalledTimes(measurements);
		const samples = (window as typeof window & { __documentRenderPerf: RenderPerfSample[] })
			.__documentRenderPerf;
		expect(samples.at(-1)).toMatchObject({
			blocksProcessed: 0,
			blocksRecomposed: 0,
			preparedArtifactsReused: 300,
			pagesChanged: 0
		});
	}
);

it('invalidates only the materialized annotation group that changed while preserving wording authority', () => {
	const baseline = documentFixture(4).blocks,
		document = createContractDocument(baseline);
	const artifacts = new DocumentArtifacts(source(document, baseline));
	cleanups.push(() => artifacts.destroy());
	const first = compose(artifacts).blocks;
	const target = {
		kind: 'text' as const,
		range: { start: { sourceKey: 'text-0', offset: 0 }, end: { sourceKey: 'text-0', offset: 6 } }
	};
	const item = {
		itemId: 'owner',
		trigger: { id: 'trigger', target },
		annotations: [
			{
				id: 'annotation',
				kind: 'trigger' as const,
				triggerId: 'trigger',
				itemId: 'owner',
				target,
				highlightKind: 'rep-attachment' as const
			}
		],
		concessions: [
			{
				id: 'alternative',
				changes: [
					{
						target,
						replacement: [{ kind: 'text' as const, text: 'Must never reconstruct saved wording' }]
					}
				]
			}
		]
	};
	const next = compose(artifacts, {
		...input,
		items: [{ ...item, audience: 'rep' }],
		activeConcessions: { owner: 'alternative' }
	}).blocks;
	expect(next[0]).not.toBe(first[0]);
	next.slice(1).forEach((b, i) => expect(b).toBe(first[i + 1]));
	expect(text(next)).toBe(text(first));
	expect(text(next)).not.toContain('Must never');
	expect(
		paragraphs(next)[0].content.some((r) => r.annotations?.some((a) => a.id === 'annotation'))
	).toBe(true);
});

it('keeps current roots through interleaved cancellation, then replaces and disposes source ownership', () => {
	const baseline = documentFixture(280).blocks;
	const artifacts = new DocumentArtifacts(source(createContractDocument(baseline), baseline));
	const first = compose(artifacts).blocks;
	const request = artifacts.composition.createRequest();
	const unfinished = artifacts.createComposer().iterate({ ...input, view: 'effective' }, request);
	for (let i = 0; i < 100; i++) unfinished.next();
	pressure(artifacts.composition);
	unfinished.return();
	request.release();
	request.release();
	const after = compose(artifacts).blocks;
	after.forEach((b, i) => expect(b).toBe(first[i]));
	const replacement = createContractDocument(documentFixture(2).blocks);
	expect(artifacts.compatible(source(replacement, baseline))).toBe(false);
	const replaced = new DocumentArtifacts(source(replacement, baseline));
	cleanups.push(() => replaced.destroy());
	expect(compose(replaced, { ...input, view: 'effective' }).blocks).toHaveLength(2);
	const inFlight = artifacts.composition.createRequest();
	const iterator = artifacts.createComposer().iterate(input, inFlight);
	iterator.next();
	artifacts.destroy();
	iterator.return();
	inFlight.release();
	expect(artifacts.signal.aborted).toBe(true);
	expect(() => artifacts.composition.createRequest()).toThrow('released');
});

it('publishes no incomplete redline group and resumes with exact split/merge/add/remove lineage', () => {
	const baseline = documentFixture(4).blocks;
	let document = createContractDocument(baseline);
	const edit = (change: Parameters<typeof prepareDocumentChange>[1][number], id: string) => {
		document = applyDocumentChange(document, prepareDocumentChange(document, [change], id));
	};
	edit(
		{
			target: {
				kind: 'text',
				range: {
					start: { sourceKey: 'text-0', offset: 0 },
					end: { sourceKey: 'text-0', offset: 6 }
				}
			},
			replacement: [
				{ kind: 'text', text: 'Revised' },
				{ kind: 'paragraph-break' },
				{ kind: 'text', text: 'Split' }
			]
		},
		'split'
	);
	edit(
		{
			target: {
				kind: 'text',
				range: {
					start: { sourceKey: 'text-1', offset: 0 },
					end: { sourceKey: 'text-2', offset: 6 }
				}
			},
			replacement: [{ kind: 'text', text: 'Merged' }]
		},
		'merge'
	);
	edit(
		{
			target: { kind: 'boundary', afterBlockKey: 'paragraph-3' },
			replacement: [{ kind: 'paragraph-break' }, { kind: 'text', text: 'Added independent clause' }]
		},
		'add'
	);
	const artifacts = new DocumentArtifacts(source(document, baseline));
	cleanups.push(() => artifacts.destroy());
	const request = artifacts.composition.createRequest();
	const publish = vi.spyOn(request, 'putBlocks');
	const iterator = artifacts.createComposer().iterate(input, request);
	for (
		let i = 0;
		i < 20000 && !publish.mock.calls.some(([key]) => key.includes('contract-baseline'));
		i++
	)
		expect(iterator.next().done).toBe(false);
	// Baseline is complete, but the first derived redline group has not completed.
	expect(publish.mock.calls.filter(([key]) => key.includes('contract-redline'))).toHaveLength(0);
	iterator.return();
	request.release();
	const effective = compose(artifacts, { ...input, view: 'effective' }).blocks;
	const redline = compose(artifacts).blocks;
	expect(text(effective)).toContain('Revised\nSplit');
	expect(text(effective)).toContain('Merged');
	expect(text(redline, 'added')).toContain('Revised');
	expect(text(redline, 'removed')).toContain('Clause');
	expect(text(redline, 'added')).toContain('Added independent clause');
	const repeat = compose(artifacts).blocks;
	repeat.forEach((b, i) => expect(b).toBe(redline[i]));
	expect(paragraphs(effective).some((b) => b.content.some((r) => r.sourceOrigin))).toBe(true);
});

it('keys derived output by lineage, aliases and resolved numbering/reference semantics', () => {
	const baseline = documentFixture(3).blocks;
	for (const [i, block] of baseline.entries()) {
		if (block.kind !== 'paragraph') throw new Error('Expected paragraph');
		block.numbering = {
			itemKey: block.blockKey,
			sequenceKey: 'clauses',
			style: 'decimal',
			labelPattern: [{ level: 1 }, { text: '. ' }],
			referencePattern: [{ text: 'Section ' }, { level: 1 }]
		};
		if (i === 2)
			block.content.push({
				kind: 'reference',
				sourceKey: 'reference',
				targetItemKey: 'paragraph-0',
				display: { start: [{ text: 'Section ' }, { level: 1 }] }
			});
	}
	const document = createContractDocument(baseline),
		index = buildSourceIndex(document.blocks);
	const store = new CompositionArtifactStore();
	cleanups.push(() => store.destroy());
	function resolved(candidate: ContractDocument, view: 'effective' | 'redline' = 'redline') {
		const request = store.createRequest();
		try {
			const engine = new ContractDocumentCompositionEngine(candidate, baseline, index, store);
			const blocks = [...engine.iterate({ ...input, view }, request)].filter(
				(b): b is ResolvedBlock => Boolean(b)
			);
			store.retain(blocks);
			return blocks;
		} finally {
			request.release();
		}
	}
	const first = resolved(document);
	const aliased = { ...document, aliases: [['paragraph-0', 'paragraph-1']] as [string, string][] };
	const next = resolved(aliased);
	expect(text(first)).toContain('Section 1');
	expect(text(next)).toContain('Section 2');
	expect(next[2]).not.toBe(first[2]);
	const repeat = resolved(aliased);
	repeat.forEach((block, i) => expect(block).toBe(next[i]));
	const originalEffective = resolved(document, 'effective');
	const lineage = {
		...document,
		pieces: document.pieces.map((piece) =>
			piece.sourceKey === 'text-0'
				? {
						...piece,
						origin: { ...piece.origin, sourceKey: 'immutable-other', start: 10, end: 50 }
					}
				: piece
		)
	};
	const changed = resolved(lineage, 'effective');
	expect(changed[0]).not.toBe(originalEffective[0]);
	expect(changed[1]).toBe(originalEffective[1]);
	expect(
		paragraphs(changed)[0].content.find((run) => run.sourceKind === 'text')?.sourceOrigin?.start
	).toEqual({ sourceKey: 'immutable-other', offset: 10 });
	const removed = {
		...document,
		blocks: document.blocks.filter((b) => b.blockKey !== 'paragraph-1'),
		pieces: document.pieces.filter((p) => p.sourceKey !== 'text-1'),
		removedBlocks: ['paragraph-1']
	};
	const replacement = new DocumentArtifacts(source(removed, baseline));
	cleanups.push(() => replacement.destroy());
	const deleted = compose(replacement).blocks;
	expect(paragraphs(deleted).find((b) => b.blockKey === 'paragraph-1')).toMatchObject({
		discussionRemoved: true
	});
	expect(text(deleted, 'removed')).toContain('Clause 1');
	const deletedRepeat = compose(replacement).blocks;
	deletedRepeat.forEach((block, i) => expect(block).toBe(deleted[i]));
});
