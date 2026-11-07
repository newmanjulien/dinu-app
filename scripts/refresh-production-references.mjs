// Deliberate local-only fixture refresh, gated by exact source reconciliation AND
// independent old provision-rule output checks. Never called by seed:verify.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { readSeed, reconcile } from './reconcile-production-seed.mjs';
import { normalize, sortedKeys, frozenProvenanceKeys } from './verify-overlay-parity.mjs';
import { remapSeedSelections } from './production-seed.mjs';
const paragraphRoles = process.argv.length === 3 && process.argv[2] === '--paragraph-roles';
if (process.argv.length > 2 && !paragraphRoles)
	throw new Error('Usage: node scripts/refresh-production-references.mjs [--paragraph-roles]');
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
	const blocks = await readSeed('contractBlocks'),
		items = await readSeed('playbookItems');
	const report = await reconcile(server, blocks, items);
	assert.equal(report.mismatches.length, 0, 'Refusing to freeze unexplained migration output');
	const { composeContract } = await server.ssrLoadModule('/src/lib/contract/compose.ts');
	const { toDocumentOverlay } = await server.ssrLoadModule('/src/lib/playbook/document-overlay.ts');
	const overlays = items.map((item, i) =>
		toDocumentOverlay({ ...item, _id: `seed-item-${i}`, _creationTime: 0 })
	);
	const previous = JSON.parse(await readFile('data/reference/compositor.json', 'utf8'));
	const states = previous.flatMap((state) => {
		const selected = remapSeedSelections(items, state.selected);
		if (Object.keys(state.selected).length && !Object.keys(selected).length) return [];
		return [{ ...state, selected }];
	});
	for (const item of items)
		for (const c of item.concessions)
			for (const view of ['effective', 'redline'])
				assert.ok(
					states.some((s) => s.name === c.id && s.view === view && typeof s.sha256 === 'string'),
					`Missing trusted reference: ${c.id} (${view}); refusing a provenance-only refresh`
				);
	const hash = (value) =>
		createHash('sha256').update(JSON.stringify(value, sortedKeys)).digest('hex');
	for (const state of states) {
		const rendered = composeContract({
			blocks,
			items: overlays,
			view: state.view,
			activeConcessions: state.selected
		});
		assert.equal(
			hash(normalize(paragraphRoles ? priorRepresentation(rendered) : rendered)),
			state.sha256,
			`${state.name}: displayed output changed; refusing a provenance-only refresh`
		);
		if (paragraphRoles) {
			assert.equal(
				hash(priorRepresentation(rendered)),
				state.provenanceSha256,
				`${state.name}: source/provenance changed beyond paragraph representation`
			);
			state.sha256 = hash(normalize(rendered));
		}
		state.provenanceSha256 = createHash('sha256')
			.update(JSON.stringify(rendered, frozenProvenanceKeys))
			.digest('hex');
	}
	await writeFile('data/reference/compositor.json', JSON.stringify(states, null, '\t') + '\n');
	console.log(
		`Frozen ${states.length} states after ${report.records.length} record checks and ${report.outputScenarios.length} independent output scenarios. See data/migration/prior-compositor.json for pre-restoration hashes.`
	);
} finally {
	await server.close();
}

/** The prior seed used anchors only on heading blocks; all source/provenance stays checked. */
function priorRepresentation(blocks) {
	const oldHeadingKeys = new Set(
		blocks.filter((block) => block.kind !== 'table' && block.anchor).map((block) => block.blockKey)
	);
	return blocks.map((block) => {
		if (block.kind === 'table') return block;
		const {
			role,
			numberingDepth: _depth,
			continueNumbering: _continuation,
			boundariesAfter,
			...source
		} = block;
		// Unified paragraphs also expose formerly unavailable heading-to-heading insertion edges.
		const priorBoundaries = boundariesAfter?.filter(
			(boundary) =>
				!oldHeadingKeys.has(boundary.afterBlockKey) ||
				(boundary.nextBlockKey && !oldHeadingKeys.has(boundary.nextBlockKey))
		);
		return {
			...source,
			kind: block.anchor ? 'heading' : 'paragraph',
			...(block.anchor ? { level: role === 'title' ? 1 : 2 } : {}),
			...(role === 'title' ? { role } : {}),
			...(priorBoundaries?.length ? { boundariesAfter: priorBoundaries } : {})
		};
	});
}
