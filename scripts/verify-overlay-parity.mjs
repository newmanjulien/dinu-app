import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Compare displayed characters, revisions and original Trigger ownership across
// run splitting. The full provenance hash below also covers effect memberships.
export function normalize(blocks) {
	const runs = (content) => {
		const result = [];
		for (const { text, revision, annotations } of content) {
			if (!text) continue;
			const { itemId, triggerId } = annotations?.find((a) => a.kind === 'trigger') ?? {};
			const previous = result.at(-1);
			if (
				previous &&
				previous.revision === revision &&
				previous.itemId === itemId &&
				previous.triggerId === triggerId
			)
				previous.text += text;
			else
				result.push({
					text,
					revision,
					itemId,
					triggerId
				});
		}
		return result;
	};
	return blocks.map((block) =>
		block.kind === 'table' ? block : { ...block, content: runs(block.content) }
	);
}
export function sortedKeys(_key, value) {
	return value && typeof value === 'object' && !Array.isArray(value)
		? Object.fromEntries(
				Object.keys(value)
					.sort()
					.map((key) => [key, value[key]])
			)
		: value;
}
/** Annotation render identity moved from a mutable trigger ID to an immutable item
 * key. Compare every other provenance field against the unchanged frozen oracle. */
export function frozenProvenanceKeys(key, value) {
	if (
		value?.kind === 'trigger' &&
		typeof value.itemId === 'string' &&
		typeof value.triggerId === 'string'
	)
		return sortedKeys(key, {
			...value,
			id: JSON.stringify(['trigger', value.itemId, value.triggerId])
		});
	return sortedKeys(key, value);
}
export async function verifyOverlayParity(server, final) {
	const { composeContract } = await server.ssrLoadModule('/src/lib/contract/compose.ts');
	const { tokenizeInline } = await server.ssrLoadModule('/src/lib/document/pagination/tokenize.ts');
	const { LayoutPreparationEngine } = await server.ssrLoadModule(
		'/src/lib/document/pagination/prepare.ts'
	);
	const { paginatePreparedDocument } = await server.ssrLoadModule(
		'/src/lib/document/pagination/paginate.ts'
	);
	const { validateBlockLayoutProfile } = await server.ssrLoadModule(
		'/src/lib/document/pagination/profile.ts'
	);
	const { buildSourceIndex, resolvePoint } = await server.ssrLoadModule(
		'/src/lib/contract/source-index.ts'
	);
	const { render } = await server.ssrLoadModule('svelte/server');
	const { default: InlineContent } = await server.ssrLoadModule(
		'/src/lib/components/document/InlineContent.svelte'
	);
	const sourceIndex = buildSourceIndex(final.blocks);
	const states = JSON.parse(await readFile('data/reference/compositor.json', 'utf8'));
	for (const { name, selected, view, sha256, provenanceSha256 } of states) {
		const activeConcessions = Object.fromEntries(
			Object.entries(selected).map(([itemId, concessionId]) => {
				const concession = final.items
					.find((box) => box.itemId === itemId)
					?.concessions.find((c) => c.id === concessionId);
				assert.ok(concession, `Missing reference concession ${concessionId}`);
				return [itemId, concessionId];
			})
		);
		const actual = composeContract({ ...final, activeConcessions, view });
		assert.equal(
			createHash('sha256')
				.update(JSON.stringify(normalize(actual), sortedKeys))
				.digest('hex'),
			sha256,
			`${name} (${view}) differs from the frozen reference`
		);
		assert.equal(
			createHash('sha256').update(JSON.stringify(actual, frozenProvenanceKeys)).digest('hex'),
			provenanceSha256,
			`${name}: source/provenance changed`
		);
		const allTokens = actual.flatMap((b) =>
			b.kind === 'table' ? b.rows.flat().map((value) => ({ value })) : tokenizeInline(b.content)
		);
		for (const token of allTokens) {
			if (token.source) {
				resolvePoint(sourceIndex, token.source.start);
				resolvePoint(sourceIndex, token.source.end);
				assert.equal(token.source.start.sourceKey, token.source.end.sourceKey);
				if (token.sourceKind === 'text')
					assert.equal(token.source.end.offset - token.source.start.offset, token.value.length);
				else assert.deepStrictEqual([token.source.start.offset, token.source.end.offset], [0, 1]);
			}
			if (token.generated)
				assert.equal(token.source, undefined, 'Generated text must not claim baseline source');
		}
		// Synthetic profiles retain the constrained fragment-conservation check.
		// Their token-sized lines/ten-unit rows do not represent browser geometry.
		const preparation = new LayoutPreparationEngine();
		const prepared = actual.map((block) => preparation.prepare(block));
		const profiles = new Map(
			prepared.map((block) => {
				const f = block.fragment;
				const profile =
					f.type === 'paragraph'
						? {
								kind: 'paragraph',
								tokenCount: f.tokens.length,
								lines: f.tokens.map((_, i) => ({
									startToken: i,
									endToken: i + 1,
									top: i,
									bottom: i + 1
								})),
								contentHeight: f.tokens.length,
								marginBlockStart: 0,
								marginBlockEnd: 0
							}
						: {
								kind: 'table',
								columnWidths: Array.from({ length: f.rows[0].length }, () => 1),
								headerRowCount: f.headerRowCount,
								headerHeight: f.headerRowCount * 10,
								bodyRowHeights: f.rows.slice(f.headerRowCount).map(() => 10),
								marginBlockStart: 0,
								marginBlockEnd: 0,
								borderBlockStart: 0,
								borderBlockEnd: 0
							};
				validateBlockLayoutProfile(profile);
				return [block, profile];
			})
		);
		const pages = paginatePreparedDocument(prepared, profiles, { capacity: () => 80 });
		assert.ok(pages.length > 1);
		const seen = new Set();
		const paginated = pages
			.flatMap((page) =>
				page.placements.flatMap(({ fragment: f }) =>
					f.type === 'table' ? f.rows.flat().flatMap((c) => c.tokens) : f.tokens
				)
			)
			.filter((token) => {
				if (seen.has(token)) return false; // Repeated table headers retain the same token objects.
				seen.add(token);
				return true;
			});
		assert.deepStrictEqual(paginated, allTokens, `${name}: pagination lost text or provenance`);
		const html = render(InlineContent, {
			props: {
				tokens: allTokens,
				selectedAnnotationId: null,
				canOpenPlaybookItems: false,
				onAnnotationSelect: () => {}
			}
		}).body;
		assert.equal(
			(html.match(/data-source-start-key=/g) ?? []).length,
			allTokens.filter((t) => t.source).length
		);
		assert.equal(
			(html.match(/data-generated=/g) ?? []).length,
			allTokens.filter((t) => t.generated).length
		);
		// Source spans are now layout-only. All former membership identities must
		// remain available to the out-of-flow projection; its native controls and
		// hit geometry require browser acceptance, not server markup assertions.
		assert.equal((html.match(/data-annotation-memberships=/g) ?? []).length, 0);
		const projectedMemberships = new Set(
			final.items.flatMap((item) => item.annotations.map((annotation) => annotation.id))
		);
		for (const id of new Set(
			allTokens.flatMap((token) =>
				(token.annotations ?? []).filter((a) => a.kind === 'trigger').map((a) => a.id)
			)
		))
			assert.ok(projectedMemberships.has(id), `Missing projected Trigger annotation ${id}`);
	}
	console.log(
		`Compositor parity verified: ${states.length} effective/redline states, including combined concessions, token/fragment provenance, and server-rendered source spans.`
	);
}
