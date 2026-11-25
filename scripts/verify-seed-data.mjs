import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { verifyOverlayParity } from './verify-overlay-parity.mjs';
import { reconcile, readSeed } from './reconcile-production-seed.mjs';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
	const blocks = await readSeed(server, 'templateSourceBlocks'),
		items = await readSeed(server, 'playbookItems');
	const { validatePlaybook } = /** @type {typeof import('../src/lib/playbook/audit.ts')} */ (
		await server.ssrLoadModule('/src/lib/playbook/audit.ts')
	);
	const { toDocumentOverlay } =
		/** @type {typeof import('../src/lib/playbook/document-overlay.ts')} */ (
			await server.ssrLoadModule('/src/lib/playbook/document-overlay.ts')
		);
	validatePlaybook(blocks, items);
	const reconciliation = await reconcile(server, blocks, items);
	assert.equal(
		reconciliation.mismatches.length,
		0,
		JSON.stringify(reconciliation.mismatches.slice(0, 10))
	);
	const records = items.map((item, i) => ({
		...item,
		_id: /** @type {import('../src/convex/_generated/dataModel').Id<'playbookItems'>} */ (
			`seed-item-${i}`
		),
		_creationTime: 0,
		contentRevision: 1
	}));
	await verifyOverlayParity(server, { blocks, items: records.map(toDocumentOverlay) });
	assert.equal(blocks.length, 112);
	assert.equal(items.length, 55);
	const triggers = items.map((i) => i.trigger),
		concessions = items.flatMap((i) => i.concessions),
		changes = concessions.flatMap((c) => c.changes);
	assert.equal(triggers.length, 55);
	assert.equal(concessions.length, 21);
	assert.equal(changes.length, 29);
	const hasInstructions = (
		/** @type {import('../src/lib/playbook/model').RepInstruction} */ item
	) => Object.values(item.instructions).some((text) => Boolean(text?.trim()));
	assert.equal(items.filter((i) => hasInstructions(i) && !i.concessions.length).length, 42);
	assert.equal(items.filter((i) => hasInstructions(i) && i.concessions.length).length, 13);
	assert.equal(new Set(triggers.map((trigger) => trigger.id)).size, items.length);
	assert.equal(items.filter((i) => i.concessions.length > 1).length, 6);
	assert.equal(Math.max(...concessions.map((c) => c.changes.length)), 2);
	const { buildSourceIndex } = /** @type {typeof import('../src/lib/document/source-index.ts')} */ (
		await server.ssrLoadModule('/src/lib/document/source-index.ts')
	);
	const { targetIsEmpty, targetContainers, structuralBoundary } =
		/** @type {typeof import('../src/lib/document/ranges.ts')} */ (
			await server.ssrLoadModule('/src/lib/document/ranges.ts')
		);
	const index = buildSourceIndex(blocks);
	assert.equal(triggers.filter((t) => targetIsEmpty(index, t.target)).length, 1);
	for (const entry of [...triggers, ...changes])
		for (const container of targetContainers(index, entry.target)) {
			const block = index.blocks.get(container.blockKey);
			assert.ok(block, 'Target container must exist in the source index.');
			assert.notEqual(block.kind, 'table');
		}
	assert.equal(changes.filter((c) => structuralBoundary(index, c.target)).length, 1);
	assert.equal(changes.filter((c) => c.replacement.some((a) => a.kind === 'reference')).length, 3);
	console.log(
		'Playbook seed verified: 112 blocks, 55 items, 55 Triggers, 21 concessions, 29 locations; 0 production reconciliation mismatches.'
	);
} finally {
	await server.close();
}
