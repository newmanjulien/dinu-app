import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { assertShape } from './seed-shape.mjs';
import { verifyOverlayParity } from './verify-overlay-parity.mjs';
import { reconcile } from './reconcile-production-seed.mjs';
const rows = async (name) =>
	(await readFile(`data/convex/${name}.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse);
const blocks = await rows('contractBlocks'),
	items = await rows('playbookItems');
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
	const { baselineBlock } = await server.ssrLoadModule('/src/convex/sourceValidators.ts');
	const { playbookItem } = await server.ssrLoadModule('/src/convex/playbookValidators.ts');
	const { validatePlaybook } = await server.ssrLoadModule('/src/lib/playbook/audit.ts');
	const { toDocumentOverlay } = await server.ssrLoadModule('/src/lib/playbook/document-overlay.ts');
	blocks.forEach((b, i) => assertShape(b, baselineBlock.json, `blocks[${i}]`));
	items.forEach((item, i) => assertShape(item, playbookItem.json, `items[${i}]`));
	validatePlaybook(blocks, items);
	const reconciliation = await reconcile(server, blocks, items);
	assert.equal(
		reconciliation.mismatches.length,
		0,
		JSON.stringify(reconciliation.mismatches.slice(0, 10))
	);
	const records = items.map((item, i) => ({ ...item, _id: `seed-item-${i}`, _creationTime: 0 }));
	await verifyOverlayParity(server, { blocks, items: records.map(toDocumentOverlay) });
	assert.equal(blocks.length, 112);
	assert.equal(items.length, 56);
	const triggers = items.map((i) => i.trigger),
		concessions = items.flatMap((i) => i.concessions),
		changes = concessions.flatMap((c) => c.changes);
	assert.equal(triggers.length, 56);
	assert.equal(concessions.length, 26);
	assert.equal(changes.length, 34);
	assert.equal(items.filter((i) => i.instructions && !i.concessions.length).length, 42);
	assert.equal(items.filter((i) => i.instructions && i.concessions.length).length, 14);
	assert.equal(new Set(triggers.map((trigger) => trigger.id)).size, items.length);
	assert.equal(items.filter((i) => i.concessions.length > 1).length, 7);
	assert.equal(Math.max(...concessions.map((c) => c.changes.length)), 2);
	const { buildSourceIndex } = await server.ssrLoadModule('/src/lib/contract/source-index.ts');
	const { targetIsEmpty, rangeTouchesTable, structuralBoundary } = await server.ssrLoadModule(
		'/src/lib/contract/ranges.ts'
	);
	const index = buildSourceIndex(blocks);
	assert.equal(triggers.filter((t) => targetIsEmpty(index, t.range)).length, 2);
	assert.equal(
		triggers.filter((t) => t.range.kind === 'text' && rangeTouchesTable(index, t.range.range))
			.length,
		1
	);
	assert.equal(
		changes.filter((c) => c.range.kind === 'text' && rangeTouchesTable(index, c.range.range))
			.length,
		5
	);
	assert.equal(changes.filter((c) => structuralBoundary(index, c.range)).length, 1);
	assert.equal(changes.filter((c) => c.replacement.some((a) => a.kind === 'reference')).length, 3);
	console.log(
		'Playbook seed verified: 112 blocks, 56 items, 56 Triggers, 26 concessions, 34 locations; 0 production reconciliation mismatches.'
	);
} finally {
	await server.close();
}
