// Pure, deterministic conversion of the cleaned Convex export. No network or DB writes.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const sourceDirectory = 'data/migration/source';
export async function readExport(directory = sourceDirectory) {
	const rows = async (table) =>
		(await readFile(`${directory}/${table}/documents.jsonl`, 'utf8'))
			.split('\n')
			.filter(Boolean)
			.map(JSON.parse);
	const tables = await rows('_tables');
	assert.deepEqual(tables.map((t) => t.name).sort(), [
		'clauseBoxes',
		'contractBlocks',
		'deletedClauseBoxes'
	]);
	const [blocks, boxes, deleted] = await Promise.all(
		['contractBlocks', 'clauseBoxes', 'deletedClauseBoxes'].map(rows)
	);
	assert.equal(deleted.length, 0, 'Nonempty deletion history needs an explicit migration policy');
	return { tables, blocks, boxes, deleted };
}
function fields(value, allowed, label) {
	for (const key of Object.keys(value))
		assert.ok(allowed.includes(key), `Unmapped ${label}.${key}`);
}
const length = (atom) => (atom.kind === 'text' ? atom.text.length : 1);
// Canonical metadata for this exported source. Counters remain dynamic after concessions.
function canonicalMetadata(blocks, items) {
	const addresses = new Map();
	for (const block of blocks) {
		const numbering = block.numbering;
		if (!numbering) continue;
		const parent = numbering.parentItemKey ? addresses.get(numbering.parentItemKey) : undefined;
		assert.ok(!numbering.parentItemKey || parent, 'Missing numbering parent');
		const level = (parent?.depth ?? 0) + 1;
		const decimal = numbering.style === 'decimal';
		numbering.labelPattern = decimal
			? [{ level }, { text: '.' }]
			: [{ text: '(' }, { level }, { text: ')' }];
		if (numbering.style.includes('alpha')) numbering.alphabeticStyle = 'sequential';
		const local = decimal && !parent ? [{ level }] : [{ text: '(' }, { level }, { text: ')' }];
		numbering.referencePattern = [...(parent?.pattern ?? []), ...local];
		addresses.set(numbering.itemKey, {
			depth: level,
			pattern: numbering.referencePattern,
			parent: numbering.parentItemKey
		});
	}
	function canonicalAtom(atom) {
		if (atom.kind !== 'reference') return { ...atom };
		const first = addresses.get(atom.targetItemKey);
		const last = atom.endTargetItemKey ? addresses.get(atom.endTargetItemKey) : undefined;
		assert.ok(first && (!atom.endTargetItemKey || last), 'Missing reference target');
		const end =
			last && first.parent && first.parent === last.parent
				? [{ text: '(' }, { level: last.depth }, { text: ')' }]
				: last?.pattern;
		return { ...atom, display: { start: first.pattern, ...(end ? { end, separator: '-' } : {}) } };
	}
	for (const block of blocks) {
		if (block.kind === 'table')
			for (const row of block.rows)
				for (const cell of row) cell.content = cell.content.map(canonicalAtom);
		else block.content = block.content.map(canonicalAtom);
	}
	for (const item of items)
		for (const concession of item.concessions)
			for (const change of concession.changes)
				change.replacement = change.replacement.map(canonicalAtom);
}
export function transformExport(source) {
	const occurrences = new Map(),
		provisions = new Map(),
		manifest = { blocks: [], items: [], provisions: [] };
	const blocks = [...source.blocks]
		.sort((a, b) => a.order - b.order)
		.map((old) => {
			fields(
				old,
				[
					'_id',
					'_creationTime',
					'blockKey',
					'order',
					'kind',
					'numbering',
					'anchor',
					'level',
					'content',
					'rows',
					'variant',
					'headerRowCount'
				],
				'block'
			);
			const { _id, _creationTime, numbering, content, rows, ...base } = old;
			const block = { ...base };
			if (numbering) {
				fields(
					numbering,
					['itemKey', 'sequenceKey', 'parentItemKey', 'style', 'activationProvisionKey'],
					'numbering'
				);
				const { activationProvisionKey, ...rest } = numbering;
				block.numbering = rest;
				if (activationProvisionKey) {
					assert.equal(old.kind, 'paragraph');
					assert.equal(content.length, 1);
					assert.equal(content[0].provisionKey, activationProvisionKey);
					assert.equal(content[0].content.length, 0);
					block.optional = true;
				}
			}
			function flatten(segments, container) {
				return segments.flatMap((segment, si) => {
					fields(segment, ['content', 'clauseKey', 'occurrenceKey', 'provisionKey'], 'segment');
					const atoms = (
						segment.content.length ? segment.content : [{ kind: 'text', text: '' }]
					).map((atom, ai) => {
						fields(atom, ['kind', 'text', 'marks', 'targetItemKey', 'endTargetItemKey'], 'atom');
						if (atom.marks) fields(atom.marks, ['bold', 'italic'], 'marks');
						return { ...atom, sourceKey: `source:${container}/segment/${si}/atom/${ai}` };
					});
					const range = {
						start: { sourceKey: atoms[0].sourceKey, offset: 0 },
						end: { sourceKey: atoms.at(-1).sourceKey, offset: length(atoms.at(-1)) }
					};
					if (segment.provisionKey) {
						assert.ok(!provisions.has(segment.provisionKey), 'Duplicate provision');
						provisions.set(segment.provisionKey, range);
						manifest.provisions.push({ key: segment.provisionKey, range });
					}
					if (segment.occurrenceKey) {
						assert.ok(segment.clauseKey);
						const previous = occurrences.get(segment.occurrenceKey);
						if (previous) {
							assert.equal(previous.container, container);
							assert.equal(
								previous.lastSegment + 1,
								si,
								'Noncontiguous occurrence requires explicit mapping'
							);
							assert.equal(previous.clauseKey, segment.clauseKey);
							previous.range.end = range.end;
							previous.lastSegment = si;
						} else {
							const start =
								si === 0 && numbering && !block.optional && old.kind !== 'table'
									? { sourceKey: `number:${numbering.itemKey}`, offset: 0 }
									: range.start;
							occurrences.set(segment.occurrenceKey, {
								clauseKey: segment.clauseKey,
								container,
								lastSegment: si,
								range: { start, end: range.end }
							});
						}
					} else assert.equal(segment.clauseKey, undefined, 'Clause has no occurrence');
					return atoms;
				});
			}
			if (old.kind === 'table')
				block.rows = rows.map((row, ri) =>
					row.map((cell, ci) => {
						fields(cell, ['content'], 'cell');
						return { content: flatten(cell.content, `${old.blockKey}/cell/${ri}/${ci}`) };
					})
				);
			else block.content = flatten(content, old.blockKey);
			manifest.blocks.push({ oldId: _id, blockKey: old.blockKey });
			return block;
		});
	const items = [...source.boxes]
		.sort((a, b) => a.clauseKey.localeCompare(b.clauseKey, 'en'))
		.map((old) => {
			fields(
				old,
				[
					'_id',
					'_creationTime',
					'clauseKey',
					'summary',
					'howToExplainToBuyers',
					'commonObjections',
					'negotiation',
					'changesNeedEscalation',
					'preferredConcessions',
					'rareConcessions'
				],
				'clauseBox'
			);
			const triggers = [...occurrences]
				.filter(([, o]) => o.clauseKey === old.clauseKey)
				.map(([id, o]) => ({ id, range: o.range }));
			assert.ok(triggers.length, `No trigger for ${old.clauseKey}`);
			const instructions = Object.fromEntries(
				['summary', 'howToExplainToBuyers', 'commonObjections', 'negotiation'].map((key) => [
					key,
					old[key]
				])
			);
			instructions.changesNeedApproval = old.changesNeedEscalation;
			const concessions = ['preferred', 'rare'].flatMap((tier) =>
				old[`${tier}Concessions`].map((c) => {
					fields(c, ['concessionKey', 'copy', 'replacements'], 'concession');
					fields(c.copy, ['before', 'detail', 'after'], 'copy');
					return {
						id: c.concessionKey,
						tier,
						description: c.copy.before,
						detail: c.copy.detail,
						...(c.copy.after !== undefined ? { after: c.copy.after } : {}),
						changes: c.replacements.map((r) => {
							fields(r, ['targetProvisionKey', 'content'], 'replacement');
							assert.ok(
								provisions.has(r.targetProvisionKey),
								`Missing provision ${r.targetProvisionKey}`
							);
							for (const a of r.content) {
								fields(
									a,
									['kind', 'text', 'marks', 'targetItemKey', 'endTargetItemKey'],
									'replacementAtom'
								);
								if (a.marks) fields(a.marks, ['bold', 'italic'], 'marks');
							}
							return { range: provisions.get(r.targetProvisionKey), replacement: r.content };
						})
					};
				})
			);
			manifest.items.push({
				oldId: old._id,
				clauseKey: old.clauseKey,
				triggerIds: triggers.map((t) => t.id)
			});
			return {
				triggers,
				instructions,
				concessions
			};
		});
	assert.equal(new Set(source.boxes.map((b) => b.clauseKey)).size, source.boxes.length);
	for (const o of occurrences.values())
		assert.ok(
			source.boxes.some((b) => b.clauseKey === o.clauseKey),
			`Orphan clause ${o.clauseKey}`
		);
	canonicalMetadata(blocks, items);
	return { blocks, items, manifest };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { blocks, items, manifest } = transformExport(await readExport(process.argv[2]));
	for (const [table, rows] of [
		['contractBlocks', blocks],
		['playbookItems', items]
	])
		await writeFile(
			`data/convex/${table}.jsonl`,
			rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
		);
	await writeFile('data/migration/mapping.json', JSON.stringify(manifest, null, 2) + '\n');
	console.log(
		`Restored ${blocks.length} blocks, ${items.length} items, ${items.flatMap((i) => i.triggers).length} triggers, ${items.flatMap((i) => i.concessions).length} concessions from export.`
	);
}
