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

// These groupings are authoring choices, not a second runtime edit model.
const authoredLocations = {
	'attorneys-fees-mutual': [[0, 1, 2, 3]],
	'attorneys-fees-mutual-prevailing-party': [[0, 1, 2, 3, 4, 5]],
	'equipment-fee-quarterly-installments': [[0, 1, 2], [3]],
	'equipment-fee-refundable-at-end': [[0, 1, 2], [3]],
	'governing-law-delaware': [[0, 1, 2, 3, 4]],
	'limitations-of-liability-mutual': [[0, 1, 2, 3]],
	'term-fee-payment-monthly-autopay-after-initial-term': [
		[0, 1],
		[2, 3, 4, 5]
	],
	'term-fee-payment-monthly-autopay': [
		[0, 1, 2, 3],
		[4, 5, 6, 7, 8, 9, 10]
	]
};

/** Rebuild each continuous selection from archived wording and its exact edits. */
function consolidateLocations(blocks, triggers, changes, groups) {
	const positions = new Map(),
		slices = [],
		containers = new Map();
	let position = 0;
	for (const block of blocks) {
		if (block.numbering) positions.set(`number:${block.numbering.itemKey}`, position++);
		const contents =
			block.kind === 'table' ? block.rows.flat().map((c) => c.content) : [block.content];
		for (const content of contents) {
			const range = {
				start: { sourceKey: content[0].sourceKey, offset: 0 },
				end: { sourceKey: content.at(-1).sourceKey, offset: length(content.at(-1)) }
			};
			for (const { sourceKey, ...atom } of content) {
				containers.set(sourceKey, range);
				positions.set(sourceKey, position);
				slices.push({ position, length: length(atom), atom });
				position += length(atom);
			}
			position++;
		}
		slices.push({ position: position - 0.5, length: 0, atom: { kind: 'paragraph-break' } });
	}
	const at = (point) => {
		assert.ok(positions.has(point.sourceKey), `Missing source ${point.sourceKey}`);
		return positions.get(point.sourceKey) + point.offset;
	};
	const between = (start, end) =>
		slices.flatMap((s) => {
			if (s.atom.kind === 'paragraph-break')
				return start < s.position && s.position < end ? [s.atom] : [];
			const from = Math.max(start, s.position),
				to = Math.min(end, s.position + s.length);
			if (from >= to) return [];
			if (s.atom.kind === 'reference') {
				assert.equal(to - from, 1, 'References must remain indivisible');
				return [s.atom];
			}
			return [{ kind: 'text', text: s.atom.text.slice(from - s.position, to - s.position) }];
		});
	assert.deepEqual(
		groups.flat().sort((a, b) => a - b),
		changes.map((_, i) => i),
		'Every archived edit needs exactly one location'
	);
	return groups.map((group) => {
		const selected = group
			.map((i) => changes[i])
			.sort((a, b) => at(a.range.start) - at(b.range.start));
		const range = {
			start: containers.get(selected[0].range.start.sourceKey).start,
			end: containers.get(selected.at(-1).range.end.sourceKey).end
		};
		const owners = triggers.filter(
			(trigger) =>
				at(trigger.range.start) <= at(selected.at(-1).range.end) &&
				at(selected[0].range.start) <= at(trigger.range.end)
		);
		if (owners.length) {
			const first = owners.reduce((a, b) => (at(a.range.start) < at(b.range.start) ? a : b));
			const last = owners.reduce((a, b) => (at(a.range.end) > at(b.range.end) ? a : b));
			if (at(range.start) < at(first.range.start)) range.start = first.range.start;
			if (at(range.end) > at(last.range.end)) range.end = last.range.end;
		}
		let cursor = at(range.start);
		const replacement = [];
		for (const change of selected) {
			assert.ok(cursor <= at(change.range.start), 'Overlapping archived edits');
			replacement.push(...between(cursor, at(change.range.start)), ...change.replacement);
			cursor = at(change.range.end);
		}
		replacement.push(...between(cursor, at(range.end)));
		return { range, replacement };
	});
}

function normalizeAuthoring(blocks, items, manifest) {
	for (const [i, item] of items.entries()) {
		const clauseKey = manifest.items[i].clauseKey;
		if (clauseKey === 'fees') {
			// Leave the annual-increase lead-in plain to separate the adjacent highlights.
			item.triggers[0].range.end = {
				sourceKey: 'source:paragraph-fees/segment/3/atom/1',
				offset: 0
			};
		}
		for (const concession of item.concessions) {
			const groups = authoredLocations[concession.id];
			if (groups) {
				concession.changes = consolidateLocations(
					blocks,
					item.triggers,
					concession.changes,
					groups
				);
				manifest.items[i].authoredLocations ??= [];
				manifest.items[i].authoredLocations.push({
					concessionId: concession.id,
					archivedEdits: groups
				});
			}
			assert.ok(concession.changes.length <= 2, `Too many locations: ${concession.id}`);
			if (concession.detail.length) {
				assert.equal(concession.id, 'replacement-commercially-viable');
				concession.description += ' ' + concession.detail.join(' ');
			}
			if (concession.after) {
				assert.equal(
					concession.after,
					'(Language changed in 3. Fees and Payment and in Exhibit A)'
				);
				const paragraphs = (item.instructions.negotiation || '').split('\n\n');
				if (!paragraphs.includes(concession.after)) paragraphs.push(concession.after);
				item.instructions.negotiation = paragraphs.filter(Boolean).join('\n\n');
			}
			delete concession.detail;
			delete concession.after;
		}
		if (clauseKey === 'replacement-professional-initial-term')
			item.instructions.negotiation =
				'For the commercially viable replacement concession, the surrounding language still leaves Oceans room to use its judgment when identifying the replacement.';
		if (item.triggers.length > 1) {
			const primary = item.triggers[0];
			if (clauseKey === 'term-fee-payment')
				primary.range = { start: primary.range.start, end: item.triggers[1].range.end };
			manifest.items[i].coordinatedTriggerIds = item.triggers.slice(1).map((t) => t.id);
			item.triggers = [primary];
		}
	}
	const hidden = blocks.findIndex((b) => b.optional);
	assert.ok(hidden > 0 && hidden < blocks.length - 1);
	const placeholder = blocks[hidden];
	assert.equal(placeholder.blockKey, 'paragraph-mutual-indemnification');
	assert.equal(blocks.filter((b) => b.optional).length, 1);
	const range = { kind: 'boundary', afterBlockKey: blocks[hidden - 1].blockKey };
	const insertion =
		items[manifest.items.findIndex((m) => m.clauseKey === 'mutual-indemnification-insertion')];
	insertion.triggers[0].range = range;
	insertion.concessions[0].changes[0].range = range;
	manifest.blocks.find((b) => b.blockKey === placeholder.blockKey).virtualInsertion = range;
	blocks.splice(hidden, 1);
	for (const item of items) {
		assert.equal(item.triggers.length, 1);
		item.trigger = item.triggers[0];
		delete item.triggers;
		if (item.trigger.range !== range)
			item.trigger.range = { kind: 'text', range: item.trigger.range };
		for (const concession of item.concessions)
			for (const change of concession.changes)
				if (change.range !== range) change.range = { kind: 'text', range: change.range };
	}
}
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
	function canonicalAtom(legacy) {
		// Contract content is always regular text; archived formatting is deliberately discarded.
		const { marks: _marks, ...atom } = legacy;
		if (atom.kind !== 'reference') return atom;
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
	normalizeAuthoring(blocks, items, manifest);
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
		`Restored ${blocks.length} blocks, ${items.length} items, ${items.length} triggers, ${items.flatMap((i) => i.concessions).length} concessions from export.`
	);
}
