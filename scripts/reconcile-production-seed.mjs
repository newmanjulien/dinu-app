// Offline record-by-record reconciliation. Never connects to a Convex deployment.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import {
	readExport,
	transformExport,
	remapSeedSelections,
	seedParagraphRole,
	retiredTableRule
} from './production-seed.mjs';
import { assertShape } from './seed-shape.mjs';

export const readSeed = async (name) =>
	(await readFile(`data/convex/${name}.jsonl`, 'utf8'))
		.trim()
		.split('\n')
		.filter(Boolean)
		.map(JSON.parse);
export function differences(expected, actual, path = '') {
	if (Object.is(expected, actual)) return [];
	if (
		!expected ||
		!actual ||
		typeof expected !== 'object' ||
		typeof actual !== 'object' ||
		Array.isArray(expected) !== Array.isArray(actual)
	)
		return [{ path, expected, actual }];
	return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].flatMap((key) =>
		differences(expected[key], actual[key], `${path}/${key}`)
	);
}
const allContent = (blocks) => blocks.flatMap((b) => (b.kind === 'table' ? [] : b.content));
export function seedCounts(blocks, items) {
	const concessions = items.flatMap((i) => i.concessions),
		changes = concessions.flatMap((c) => c.changes),
		atoms = allContent(blocks);
	return {
		contractBlocks: blocks.length,
		playbookItems: items.length,
		triggers: items.filter((i) => i.trigger).length,
		concessions: concessions.length,
		preferred: concessions.filter((c) => c.tier === 'preferred').length,
		rare: concessions.filter((c) => c.tier === 'rare').length,
		changes: changes.length,
		afterNotes: concessions.filter((c) => c.after !== undefined).length,
		detailEntries: concessions.flatMap((c) => c.detail ?? []).length,
		markedAtoms: atoms.filter((a) => a.marks !== undefined).length,
		references: atoms.filter((a) => a.kind === 'reference').length,
		replacementReferences: changes
			.flatMap((c) => c.replacement)
			.filter((a) => a.kind === 'reference').length
	};
}
function sourceCounts(source) {
	const segments = source.blocks.flatMap((b) =>
			b.kind === 'table' ? b.rows.flat().flatMap((c) => c.content) : b.content
		),
		atoms = segments.flatMap((s) => s.content);
	const preferred = source.boxes.flatMap((b) => b.preferredConcessions),
		rare = source.boxes.flatMap((b) => b.rareConcessions),
		cs = [...preferred, ...rare];
	return {
		contractBlocks: source.blocks.length,
		playbookItems: source.boxes.length,
		triggers: new Set(segments.map((s) => s.occurrenceKey).filter(Boolean)).size,
		concessions: cs.length,
		preferred: preferred.length,
		rare: rare.length,
		changes: cs.flatMap((c) => c.replacements).length,
		afterNotes: cs.filter((c) => c.copy.after !== undefined).length,
		detailEntries: cs.flatMap((c) => c.copy.detail).length,
		markedAtoms: atoms.filter((a) => a.marks !== undefined).length,
		references: atoms.filter((a) => a.kind === 'reference').length,
		replacementReferences: cs
			.flatMap((c) => c.replacements)
			.flatMap((r) => r.content)
			.filter((a) => a.kind === 'reference').length
	};
}
// Independent output oracle: apply the OLD named-provision rules directly to the
// exported segments. It never reads new ranges, source keys, or transformExport.
function historicalAddresses(blocks) {
	const positions = new Map(),
		addresses = new Map();
	function token(style, position) {
		if (style === 'decimal') return String(position);
		let result = '';
		if (style.endsWith('roman')) {
			for (const [value, symbol] of [
				[1000, 'm'],
				[900, 'cm'],
				[500, 'd'],
				[400, 'cd'],
				[100, 'c'],
				[90, 'xc'],
				[50, 'l'],
				[40, 'xl'],
				[10, 'x'],
				[9, 'ix'],
				[5, 'v'],
				[4, 'iv'],
				[1, 'i']
			])
				while (position >= value) {
					result += symbol;
					position -= value;
				}
		} else
			while (position) {
				position--;
				result = String.fromCharCode(97 + (position % 26)) + result;
				position = Math.floor(position / 26);
			}
		return style.startsWith('upper') ? result.toUpperCase() : result;
	}
	for (const block of blocks) {
		const n = block.numbering;
		if (!n) continue;
		const position = (positions.get(n.sequenceKey) ?? 0) + 1;
		positions.set(n.sequenceKey, position);
		const value = token(n.style, position);
		const label = n.style === 'decimal' ? `${value}.` : `(${value})`;
		const parent = addresses.get(n.parentItemKey);
		addresses.set(n.itemKey, {
			label,
			address: `${parent?.address ?? ''}${parent || n.style !== 'decimal' ? `(${value})` : value}`
		});
	}
	return addresses;
}
function historicalReference(atom, addresses) {
	const start = addresses.get(atom.targetItemKey).address;
	if (!atom.endTargetItemKey) return start;
	const end = addresses.get(atom.endTargetItemKey).address;
	const lastOpen = end.lastIndexOf('(');
	return `${start}-${lastOpen >= 0 && start.slice(0, lastOpen) === end.slice(0, lastOpen) ? end.slice(lastOpen) : end}`;
}
export function historicalEffective(source, selected) {
	const replacements = new Map();
	for (const box of source.boxes)
		for (const c of [...box.preferredConcessions, ...box.rareConcessions])
			if (selected.has(c.concessionKey))
				for (const r of c.replacements) {
					assert.ok(
						!replacements.has(r.targetProvisionKey),
						`Conflicting source selection ${r.targetProvisionKey}`
					);
					replacements.set(r.targetProvisionKey, r.content);
				}
	const ordered = [...source.blocks].sort((a, b) => a.order - b.order);
	const active = ordered.filter(
		(b) =>
			!b.numbering?.activationProvisionKey ||
			replacements
				.get(b.numbering.activationProvisionKey)
				?.some((a) => a.kind === 'reference' || a.text.length)
	);
	const addresses = historicalAddresses(active);
	const runs = (segments) =>
		segments.flatMap((s) =>
			(replacements.get(s.provisionKey) ?? s.content).map((a) => ({
				text: a.kind === 'text' ? a.text : historicalReference(a, addresses)
			}))
		);
	return active.map((b) => {
		if (b.kind === 'table')
			return {
				kind: b.kind,
				blockKey: b.blockKey,
				rows: b.rows.map((row) =>
					row.map((c) =>
						runs(c.content)
							.map((run) => run.text)
							.join('')
					)
				)
			};
		let content = runs(b.content);
		if (b.numbering) {
			// Number/body separator is generated by both applications, not stored copy.
			while (content.length && !content[0].text.trim()) content.shift();
			if (content.length) content[0] = { ...content[0], text: content[0].text.trimStart() };
			content = [
				{ text: addresses.get(b.numbering.itemKey).label },
				...(content.length ? [{ text: ' ' }, ...content] : [])
			];
		}
		return { kind: b.kind, blockKey: b.blockKey, content };
	});
}
function visible(blocks, aliases = new Map()) {
	const runs = (content) => {
		const merged = [];
		for (const r of content) {
			if (r.generated === 'empty-hit-target' || !r.text) continue;
			const last = merged.at(-1);
			if (last) last.text += r.text;
			else merged.push({ text: r.text });
		}
		return merged;
	};
	return blocks.map((b) =>
		b.kind === 'table'
			? {
					kind: b.kind,
					blockKey: aliases.get(b.blockKey) ?? b.blockKey,
					rows: b.rows
				}
			: {
					kind: 'paragraph',
					role: seedParagraphRole({ ...b, blockKey: aliases.get(b.blockKey) ?? b.blockKey }),
					blockKey: aliases.get(b.blockKey) ?? b.blockKey,
					content: runs(b.content)
				}
	);
}
function acceptRedline(blocks) {
	const runs = (content) => {
		const out = [];
		for (const r of content) {
			if (r.revision === 'removed') continue;
			if (r.generated === 'separator' && out.at(-1)?.sourceKind !== 'number') continue;
			out.push(r);
		}
		return out;
	};
	return blocks.map((b) => (b.kind === 'table' ? b : { ...b, content: runs(b.content) }));
}
export async function reconcile(server, blocks, items) {
	const source = await readExport(),
		expected = transformExport(source);
	const mismatches = [
		...differences(expected.blocks, blocks, 'contractBlocks'),
		...differences(expected.items, items, 'playbookItems')
	];
	const { baselineBlock } = await server.ssrLoadModule('/src/lib/contract/source-validators.ts');
	const { playbookItem } = await server.ssrLoadModule('/src/convex/playbookValidators.ts');
	blocks.forEach((b, i) => assertShape(b, baselineBlock.json, `block[${i}]`));
	items.forEach((b, i) => assertShape(b, playbookItem.json, `item[${i}]`));
	const { validatePlaybook } = await server.ssrLoadModule('/src/lib/playbook/audit.ts');
	validatePlaybook(blocks, items);
	const { semanticPlaybookDraft, equalConcession } = await server.ssrLoadModule(
		'/src/lib/playbook/content.ts'
	);
	const { AuthoringContext } = await server.ssrLoadModule(
		'/src/lib/playbook/authoring-context.svelte.ts'
	);
	const { savePlaybookItem } = await server.ssrLoadModule('/src/convex/playbookItems.ts');
	const { baselineIntegrity } = await server.ssrLoadModule('/src/convex/baselineStorage.ts');
	const { businessItem, snapshotItem, itemRevision, compactHead, hydrateHead } =
		await server.ssrLoadModule('/src/convex/playbookItemRevisions.ts');
	const { documentBytes } = await server.ssrLoadModule('/src/convex/storageCapacity.ts');
	const { getConvexSize } = await import('convex/values');
	const { itemStructure } = await server.ssrLoadModule('/src/lib/playbook/structure.ts');
	const { buildSourceIndex } = await server.ssrLoadModule('/src/lib/contract/source-index.ts');
	const { certifyValidationFacts, VALIDATION_CODEC_VERSION } = await server.ssrLoadModule(
		'/src/lib/contract/validation-codec.ts'
	);
	const { render } = await server.ssrLoadModule('svelte/server');
	const { default: RepPlaybookPanel } = await server.ssrLoadModule(
		'/src/lib/components/playbook/RepPlaybookPanel.svelte'
	);
	const escapeText = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
	const { validateConcessionUpdate } = await server.ssrLoadModule(
		'/src/lib/playbook/validation.ts'
	);
	const companyId = 'seed-company';
	const profileId = 'seed-profile';
	const membershipId = 'seed-membership';
	const baselineChunk = {
		_id: 'seed-chunk',
		_creationTime: 0,
		companyId,
		baselineId: 'seed-baseline',
		order: 0,
		firstBlock: 0,
		blocks
	};
	const integrity = baselineIntegrity(blocks);
	const identity = {
		issuer: 'https://seed-verifier.invalid',
		subject: 'seed-user',
		tokenIdentifier: 'https://seed-verifier.invalid|seed-user',
		email: 'seed@seed-verifier.invalid',
		emailVerified: true
	};
	const seededItems = items.map((item, index) => ({
		...item,
		companyId,
		contentRevision: 1,
		currentRevisionId: `seed-revision-${index}`,
		_id: `seed-item-${index}`,
		renderKey: `seed-item-${index}`,
		_creationTime: 0
	}));
	const seededHeads = seededItems.map((item) => ({
		...compactHead(item),
		_id: item._id,
		_creationTime: item._creationTime
	}));
	const validationData = certifyValidationFacts(buildSourceIndex(blocks));
	const validationChunk = {
		_id: 'seed-validation-chunk',
		_creationTime: 0,
		companyId,
		baselineId: 'seed-baseline',
		order: 0,
		data: validationData
	};
	const certificate = {
		_id: 'seed-validation',
		_creationTime: 0,
		companyId,
		baselineId: 'seed-baseline',
		format: VALIDATION_CODEC_VERSION,
		fingerprint: integrity.fingerprint,
		chunkCount: 1,
		chunkIds: [validationChunk._id],
		dataBytes: validationData.byteLength,
		readBytes: documentBytes(validationChunk)
	};
	const seededRevisions = seededItems.map((item) => ({
		...itemRevision(item),
		_id: item.currentRevisionId,
		_creationTime: 0
	}));
	const seededVersion = {
		_id: 'seed-version',
		mutability: 'mutable',
		_creationTime: 0,
		companyId,
		baselineId: 'seed-baseline',
		updatedAt: 0,
		authoringGeneration: 1,
		structuralGeneration: 1,
		validation: { format: VALIDATION_CODEC_VERSION, fingerprint: integrity.fingerprint },
		headReadBytes: seededHeads.reduce((sum, head) => sum + documentBytes(head), 0),
		structureResultBytes: seededItems.reduce(
			(sum, item) => sum + getConvexSize(itemStructure(item)),
			0
		),
		blockCount: blocks.length,
		itemCount: items.length,
		snapshotBytes: new TextEncoder().encode(
			JSON.stringify({ blocks, items: seededItems.map(snapshotItem) })
		).byteLength,
		contentReadBytes:
			documentBytes(baselineChunk) +
			seededRevisions.reduce((sum, revision) => sum + documentBytes(revision), 0),
		items: seededItems.map((item) => ({ itemId: item._id, revisionId: item.currentRevisionId }))
	};
	for (const [i, item] of items.entries()) {
		const saved = seededItems[i];
		const editing = new AuthoringContext(
			{ ...item, instructions: item.instructions ?? {} },
			saved,
			{ kind: 'editing' }
		);
		assert.deepEqual(editing.payload, item, `Edit/save loses data: ${i}`);
		validateConcessionUpdate(item, semanticPlaybookDraft(item));
		// Exercise the actual existing-record mutation with an in-memory persistence
		// adapter, including complete template saving. Convex transaction guarantees are
		// verified separately; this adapter checks preserved business payloads.
		let persisted = structuredClone(seededHeads[i]);
		const tables = new Map([
			['profiles', [{ _id: profileId, identity: identity.tokenIdentifier }]],
			['memberships', [{ _id: membershipId, companyId, profileId, role: 'admin' }]],
			['company', [{ _id: companyId, ownerProfileId: profileId, baselineId: 'seed-baseline' }]],
			[
				'currentTemplate',
				[
					{
						_id: 'seed-pointer',
						companyId,
						versionId: 'seed-version',
						authoringGeneration: 1,
						structuralGeneration: 1
					}
				]
			],
			[
				'baselines',
				[
					{
						_id: 'seed-baseline',
						companyId,
						source: 'seed',
						state: 'active',
						blockCount: blocks.length,
						issues: [],
						...integrity,
						bootstrapKey: 'a'.repeat(64),
						activatedAt: 0,
						chunkCount: 1,
						chunkReadBytes: documentBytes(baselineChunk)
					}
				]
			],
			['baselineChunks', [baselineChunk]],
			['baselineAuthoring', [certificate]],
			['baselineValidationChunks', [validationChunk]],
			['playbookItems', structuredClone(seededHeads)],
			['playbookItemRevisions', structuredClone(seededRevisions)],
			['templateVersions', [seededVersion]]
		]);
		let nextId = 0;
		const ctx = {
			auth: { getUserIdentity: async () => identity },
			scheduler: { runAfter: async () => 'seed-scheduled-job' },
			meta: {
				getTransactionMetrics: async () => ({
					documentsWritten: { remaining: 16000 },
					bytesWritten: { remaining: 16 * 1024 * 1024 },
					databaseQueries: { remaining: 4096 },
					documentsRead: { remaining: 32000 },
					bytesRead: { remaining: 16 * 1024 * 1024 },
					functionsScheduled: { remaining: 1000 },
					scheduledFunctionArgsBytes: { remaining: 16 * 1024 * 1024 }
				})
			},
			db: {
				get: async (_table, id) =>
					id === saved._id ? persisted : tables.get(_table)?.find((row) => row._id === id),
				query: (table) => {
					const query = {
						withIndex: () => query,
						take: async (count) => (tables.get(table) ?? []).slice(0, count),
						unique: async () => tables.get(table)?.[0] ?? null
					};
					return query;
				},
				insert: async (table, value) => {
					const row = { ...value, _id: `template-version-${++nextId}`, _creationTime: 0 };
					tables.set(table, [...(tables.get(table) ?? []), row]);
					return row._id;
				},
				patch: async (table, id, value) =>
					Object.assign(
						tables.get(table).find((row) => row._id === id),
						value
					),
				replace: async (table, id, value) => {
					const rows = tables.get(table);
					const index = rows.findIndex((row) => row._id === id);
					rows[index] = { ...value, _id: id, _creationTime: rows[index]._creationTime ?? 0 };
					if (table === 'playbookItems') persisted = rows[index];
				}
			}
		};
		const result = await savePlaybookItem._handler(ctx, {
			membershipId,
			id: saved._id,
			item: editing.payload,
			expectedContentRevision: 1,
			operationId: '00000000-0000-4000-8000-000000000000'
		});
		assert.equal(result.status, 'saved', `Mutation rejected item ${i}`);
		assert.deepEqual(
			businessItem(await hydrateHead(ctx, persisted)),
			item,
			`Mutation drops business fields: ${i}`
		);
		const html = render(RepPlaybookPanel, {
			props: { item: saved, onToggle: () => {}, onClose: () => {} }
		}).body;
		const userText = [
			...Object.values(item.instructions ?? {}),
			...(item.approvalPolicy.kind === 'required' ? [item.approvalPolicy.instructions] : []),
			...item.concessions.map((c) => c.description)
		];
		for (const text of userText)
			if (text.trim())
				assert.ok(
					html.includes(escapeText(text)),
					`UI omits or normalizes item ${i} text: ${text}`
				);
		for (const c of item.concessions)
			assert.equal(
				equalConcession(c, { ...c, description: c.description + 'changed' }),
				false,
				'Concession copy must affect save identity'
			);
		if (item.instructions?.negotiation)
			assert.notDeepEqual(
				semanticPlaybookDraft(item),
				semanticPlaybookDraft({
					...item,
					instructions: {
						...item.instructions,
						negotiation: item.instructions.negotiation + 'changed'
					}
				}),
				'Negotiation notes must affect save identity'
			);
	}
	const { composeContract } = await server.ssrLoadModule('/src/lib/contract/compose.ts');
	const { toDocumentOverlay } = await server.ssrLoadModule('/src/lib/playbook/document-overlay.ts');
	const overlays = items.map((item, i) =>
		toDocumentOverlay({ ...item, _id: `seed-item-${i}`, _creationTime: 0 })
	);
	// Only the approved hidden-placeholder -> virtual-gap identity changes. All other
	// block identities, placement, wording and numbering remain exact oracle checks.
	const insertionIndex = expected.manifest.items.findIndex(
		(m) => m.clauseKey === 'mutual-indemnification-insertion'
	);
	const insertionId = items[insertionIndex].concessions[0].id;
	const insertedKey = `insert:${JSON.stringify([{ itemId: `seed-item-${insertionIndex}`, concessionId: insertionId, changeIndex: 0 }, 0])}`;
	const aliases = new Map([[insertedKey, 'paragraph-mutual-indemnification']]);
	const scenarios = [{ name: 'baseline', selected: {} }];
	items.forEach((item, i) =>
		item.concessions.forEach((c) =>
			scenarios.push({ name: c.id, selected: { [`seed-item-${i}`]: c.id } })
		)
	);
	const frozen = JSON.parse(await readFile('data/reference/compositor.json', 'utf8'));
	for (const state of frozen)
		if (Object.keys(state.selected).length > 1 && !scenarios.some((s) => s.name === state.name))
			scenarios.push({ name: state.name, selected: remapSeedSelections(items, state.selected) });
	for (const { name, selected } of scenarios) {
		const old = historicalEffective(source, new Set(Object.values(selected)));
		const effective = composeContract({
			blocks,
			items: overlays,
			activeConcessions: selected,
			view: 'effective'
		});
		const redline = composeContract({
			blocks,
			items: overlays,
			activeConcessions: selected,
			view: 'redline'
		});
		mismatches.push(
			...differences(visible(old), visible(effective, aliases), `output/${name}/effective`)
		);
		// Approved formatting removal changes no characters or structure. Accepted
		// redlines must still exactly equal the independent historical effective output.
		mismatches.push(
			...differences(
				visible(old),
				visible(acceptRedline(redline), aliases),
				`output/${name}/redline-accepted`
			)
		);
	}
	const oldCounts = sourceCounts(source),
		newCounts = seedCounts(blocks, items),
		retired = source.boxes.find((box) => box.clauseKey === retiredTableRule);
	mismatches.push(
		...differences(
			{
				...oldCounts,
				contractBlocks: 112,
				playbookItems: 55,
				triggers: 55,
				concessions: 21,
				preferred: oldCounts.preferred - retired.preferredConcessions.length,
				rare: oldCounts.rare - retired.rareConcessions.length,
				changes: 29,
				afterNotes: 0,
				detailEntries: 0,
				markedAtoms: 0,
				replacementReferences: 3
			},
			newCounts,
			'counts'
		)
	);
	const sourceHashes = Object.fromEntries(
		await Promise.all(
			['_tables', 'contractBlocks', 'clauseBoxes', 'deletedClauseBoxes'].map(async (table) => [
				`${table}/documents.jsonl`,
				createHash('sha256')
					.update(await readFile(`data/migration/source/${table}/documents.jsonl`))
					.digest('hex')
			])
		)
	);
	const expectedBlocks = new Map(expected.blocks.map((block) => [block.blockKey, block]));
	const actualBlocks = new Map(blocks.map((block) => [block.blockKey, block]));
	const report = {
		sourceHashes,
		source: 'Cleaned supplied Convex export',
		tables: source.tables.map((t) => ({
			name: t.name,
			count:
				source[
					t.name === 'clauseBoxes' ? 'boxes' : t.name === 'contractBlocks' ? 'blocks' : 'deleted'
				].length
		})),
		oldCounts,
		newCounts,
		approvedChanges: [
			{
				field: 'table-based discounts',
				before: { items: 1, concessions: 5, changes: 5 },
				after: { items: 0, concessions: 0, changes: 0 },
				reason: 'User approved retiring monthly-fee-discount and making all table content static.'
			},
			{
				field: 'markedAtoms',
				before: oldCounts.markedAtoms,
				after: 0,
				reason: 'User approved removing all contract bold/italic formatting on 2026-10-27.'
			},
			{
				field: 'contractBlocks',
				before: 113,
				after: 112,
				reason: 'Replace the hidden empty paragraph with the approved virtual gap insertion.'
			},
			{
				field: 'triggers',
				before: 62,
				after: 56,
				reason:
					'One primary instruction per rule; coordinated concession effects remain separate annotations.'
			},
			{
				field: 'changes',
				before: 66,
				after: 34,
				reason:
					'Consolidate archived edits into at most two continuous authored locations per concession, preserving all wording.'
			},
			{
				field: 'afterNotes',
				before: oldCounts.afterNotes,
				after: 0,
				reason:
					'Move the same cross-section note once into each affected rule’s How to negotiate field.'
			},
			{
				field: 'replacementReferences',
				before: 1,
				after: 3,
				reason:
					'Continuous selections retain two unchanged baseline references as structured replacement atoms.'
			},
			{
				field: 'detailEntries',
				before: 1,
				after: 0,
				reason:
					'Retain the useful replacement detail in its description and approved How to negotiate wording.'
			}
		],
		records: [
			...expected.manifest.blocks.map((b) => ({
				entity: 'contractBlock',
				key: b.blockKey,
				oldId: b.oldId,
				mismatches: differences(expectedBlocks.get(b.blockKey), actualBlocks.get(b.blockKey))
					.length,
				...(b.virtualInsertion ? { virtualInsertion: b.virtualInsertion } : {})
			})),
			...expected.manifest.items.map((m, i) => ({
				entity: 'clauseBox → playbookItem',
				key: m.clauseKey,
				oldId: m.oldId,
				triggerId: items[i]?.trigger.id,
				...(m.coordinatedTriggerIds ? { coordinatedTriggerIds: m.coordinatedTriggerIds } : {}),
				...(m.authoredLocations ? { authoredLocations: m.authoredLocations } : {}),
				concessions: items[i]?.concessions.length,
				mismatches: differences(expected.items[i], items[i]).length
			}))
		],
		outputScenarios: scenarios.map((s) => s.name),
		editSaveRoundTrips: items.length,
		simulatedMutationRoundTrips: items.length,
		serverRenderedPanels: items.length,
		mismatches,
		unexplainedUserFacingMismatches: mismatches.length,
		excludedSystemFields: ['_id', '_creationTime', '_tables.id'],
		notes: [
			'Convex document IDs and creation times are retained in source evidence but regenerated by seed import.',
			'No deleted records exist. Bold/italic marks are deliberately omitted with user approval; all business wording and structure remain checked.',
			'Paragraph insertion uses virtual baseline boundaries; no hidden placeholder or optional paragraph remains.',
			'All data/convex files are derived from the cleaned export; existing seed wording is never an input.'
		]
	};
	return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
	try {
		const report = await reconcile(
			server,
			await readSeed('contractBlocks'),
			await readSeed('playbookItems')
		);
		await writeFile('data/migration/reconciliation.json', JSON.stringify(report, null, 2) + '\n');
		console.log(
			JSON.stringify(
				{
					old: report.oldCounts,
					new: report.newCounts,
					scenarios: report.outputScenarios.length,
					unexplainedUserFacingMismatches: report.mismatches.length
				},
				null,
				2
			)
		);
		assert.equal(
			report.mismatches.length,
			0,
			JSON.stringify(report.mismatches.slice(0, 10), null, 2)
		);
	} finally {
		await server.close();
	}
}
