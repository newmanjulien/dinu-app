// Offline record-by-record reconciliation. Never connects to a Convex deployment.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { convexTest } from 'convex-test';
import {
	readExport,
	transformExport,
	remapSeedSelections,
	materializeSeedSelections,
	seedParagraphRole,
	retiredTableRule,
	present
} from './production-seed.mjs';
import { assertShape, validatorJson, readFrozenStates } from './seed-shape.mjs';

/**
 * @overload
 * @param {import('vite').ViteDevServer} server
 * @param {'templateSourceBlocks'} name
 * @param {string} [path]
 * @returns {Promise<import('../src/lib/document/source-model').SourceBlock[]>}
 */
/**
 * @overload
 * @param {import('vite').ViteDevServer} server
 * @param {'playbookItems'} name
 * @param {string} [path]
 * @returns {Promise<import('../src/lib/playbook/model').RepInstruction[]>}
 */
/** @param {import('vite').ViteDevServer} server @param {'templateSourceBlocks'|'playbookItems'} name @param {string} [path] */
export async function readSeed(server, name, path = `data/convex/${name}.jsonl`) {
	const source = (await readFile(path, 'utf8')).trim();
	if (!source) throw new Error(`${name} import records are empty.`);
	/** @type {unknown[]} */
	const rows = source.split('\n').map((line) => JSON.parse(line));
	const { sourceBlock } = /** @type {typeof import('../src/lib/document/source-validators.ts')} */ (
		await server.ssrLoadModule('/src/lib/document/source-validators.ts')
	);
	const { repInstruction } = /** @type {typeof import('../src/convex/playbookValidators.ts')} */ (
		await server.ssrLoadModule('/src/convex/playbookValidators.ts')
	);
	rows.forEach((row, i) =>
		assertShape(
			row,
			validatorJson(name === 'templateSourceBlocks' ? sourceBlock : repInstruction),
			`${name}[${i}]`
		)
	);
	// The fixed table name selects its complete persisted validator above.
	return /** @type {import('../src/lib/document/source-model').SourceBlock[] | import('../src/lib/playbook/model').RepInstruction[]} */ (
		rows
	);
}
/** @param {unknown} expected @param {unknown} actual @param {string} [path] @returns {{path:string;expected:unknown;actual:unknown}[]} */
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
		differences(
			/** @type {Record<string,unknown>} */ (expected)[key],
			/** @type {Record<string,unknown>} */ (actual)[key],
			`${path}/${key}`
		)
	);
}
/** @param {import('../src/lib/document/source-model').SourceBlock[]} blocks */
const allContent = (blocks) => blocks.flatMap((b) => (b.kind === 'table' ? [] : b.content));
/** @param {import('../src/lib/document/source-model').SourceBlock[]} blocks @param {import('../src/lib/playbook/model').RepInstruction[]} items */
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
		afterNotes: concessions.filter((c) => 'after' in c && c.after !== undefined).length,
		detailEntries: concessions.flatMap((c) =>
			'detail' in c && Array.isArray(c.detail) ? c.detail : []
		).length,
		markedAtoms: atoms.filter((a) => 'marks' in a && a.marks !== undefined).length,
		references: atoms.filter((a) => a.kind === 'reference').length,
		replacementReferences: changes
			.flatMap((c) => c.replacement)
			.filter((a) => a.kind === 'reference').length
	};
}
/** @param {import('./seed-types').LegacyExport} source */
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
		markedAtoms: atoms.filter((a) => 'marks' in a && a.marks !== undefined).length,
		references: atoms.filter((a) => a.kind === 'reference').length,
		replacementReferences: cs
			.flatMap((c) => c.replacements)
			.flatMap((r) => r.content)
			.filter((a) => a.kind === 'reference').length
	};
}
// Independent output oracle: apply the OLD named-provision rules directly to the
// exported segments. It never reads new ranges, source keys, or transformExport.
/** @param {import('./seed-types').LegacyBlock[]} blocks */
function historicalAddresses(blocks) {
	/** @type {Map<string,number>} */
	const positions = new Map();
	/** @type {Map<string,{label:string;address:string}>} */
	const addresses = new Map();
	/** @param {string} style @param {number} position */
	function token(style, position) {
		if (style === 'decimal') return String(position);
		let result = '';
		if (style.endsWith('roman')) {
			for (const [value, symbol] of /** @type {const} */ ([
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
			]))
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
		const parent = n.parentItemKey ? addresses.get(n.parentItemKey) : undefined;
		addresses.set(n.itemKey, {
			label,
			address: `${parent?.address ?? ''}${parent || n.style !== 'decimal' ? `(${value})` : value}`
		});
	}
	return addresses;
}
/** @param {Extract<import('./seed-types').LegacyAtom,{kind:'reference'}>} atom @param {Map<string,{label:string;address:string}>} addresses */
function historicalReference(atom, addresses) {
	const start = present(addresses.get(atom.targetItemKey)).address;
	if (!atom.endTargetItemKey) return start;
	const end = present(addresses.get(atom.endTargetItemKey)).address;
	const lastOpen = end.lastIndexOf('(');
	return `${start}-${lastOpen >= 0 && start.slice(0, lastOpen) === end.slice(0, lastOpen) ? end.slice(lastOpen) : end}`;
}
/** @param {import('./seed-types').LegacyExport} source @param {Set<string>} selected */
export function historicalEffective(source, selected) {
	/** @type {Map<string,import('./seed-types').LegacyAtom[]>} */
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
	/** @param {import('./seed-types').LegacySegment[]} segments */
	const runs = (segments) =>
		segments.flatMap((s) =>
			((s.provisionKey ? replacements.get(s.provisionKey) : undefined) ?? s.content).map((a) => ({
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
				{ text: present(addresses.get(b.numbering.itemKey)).label },
				...(content.length ? [{ text: ' ' }, ...content] : [])
			];
		}
		return { kind: b.kind, blockKey: b.blockKey, content };
	});
}
/** @param {({kind:'table';blockKey:string;rows:string[][]}|{kind:'paragraph'|'heading';blockKey:string;role?:import('../src/lib/document/source-model').ParagraphRole;content:{text:string;generated?:string}[]})[]} blocks @param {Map<string,string>} [aliases] */
function visible(blocks, aliases = new Map()) {
	/** @param {{text:string;generated?:string}[]} content */
	const runs = (content) => {
		/** @type {{text:string}[]} */
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
/** @param {import('../src/lib/document/model').ResolvedBlock[]} blocks */
function acceptRedline(blocks) {
	/** @param {import('../src/lib/document/model').ResolvedRun[]} content */
	const runs = (content) => {
		/** @type {import('../src/lib/document/model').ResolvedRun[]} */
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
/** @param {import('vite').ViteDevServer} server @param {import('../src/lib/document/source-model').SourceBlock[]} blocks @param {import('../src/lib/playbook/model').RepInstruction[]} items */
export async function reconcile(server, blocks, items) {
	const source = await readExport(),
		expected = transformExport(source);
	const mismatches = [
		...differences(expected.blocks, blocks, 'contractBlocks'),
		...differences(expected.items, items, 'playbookItems')
	];
	const { sourceBlock } = /** @type {typeof import('../src/lib/document/source-validators.ts')} */ (
		await server.ssrLoadModule('/src/lib/document/source-validators.ts')
	);
	const { repInstruction } = /** @type {typeof import('../src/convex/playbookValidators.ts')} */ (
		await server.ssrLoadModule('/src/convex/playbookValidators.ts')
	);
	blocks.forEach((b, i) => assertShape(b, validatorJson(sourceBlock), `block[${i}]`));
	items.forEach((b, i) => assertShape(b, validatorJson(repInstruction), `item[${i}]`));
	const { validatePlaybook } = /** @type {typeof import('../src/lib/playbook/audit.ts')} */ (
		await server.ssrLoadModule('/src/lib/playbook/audit.ts')
	);
	validatePlaybook(blocks, items);
	const { semanticRepInstruction, equalConcession } =
		/** @type {typeof import('../src/lib/playbook/content.ts')} */ (
			await server.ssrLoadModule('/src/lib/playbook/content.ts')
		);
	const { AuthoringContext } =
		/** @type {typeof import('../src/lib/playbook/authoring-context.svelte.ts')} */ (
			await server.ssrLoadModule('/src/lib/playbook/authoring-context.svelte.ts')
		);
	const { default: schema } = /** @type {typeof import('../src/convex/schema.ts')} */ (
		await server.ssrLoadModule('/src/convex/schema.ts')
	);
	const { api, internal } = /** @type {typeof import('../src/convex/_generated/api.js')} */ (
		await server.ssrLoadModule('/src/convex/_generated/api.js')
	);
	const { businessItem, hydrateHead } =
		/** @type {typeof import('../src/convex/playbookItemRevisions.ts')} */ (
			await server.ssrLoadModule('/src/convex/playbookItemRevisions.ts')
		);
	const modulePaths = (await readdir('src/convex'))
		.filter((path) => path.endsWith('.ts'))
		.map((path) => `/src/convex/${path}`);
	modulePaths.push('/src/convex/_generated/server.js');
	const modules = Object.fromEntries(
		modulePaths.map((path) => [path, () => server.ssrLoadModule(path)])
	);
	const { render } = /** @type {typeof import('svelte/server')} */ (
		await server.ssrLoadModule('svelte/server')
	);
	const { default: RepPlaybookPanel } =
		/** @type {{default:import('svelte').Component<{item:import('../src/lib/contract/items').ResolvedContractItem;onToggle:(id:string)=>void;onClose:()=>void}>}} */ (
			await server.ssrLoadModule('/src/lib/components/playbook/RepPlaybookPanel.svelte')
		);
	/** @param {string} text */
	const escapeText = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
	const { resolveTemplateItem } = /** @type {typeof import('../src/lib/contract/items.ts')} */ (
		await server.ssrLoadModule('/src/lib/contract/items.ts')
	);
	const { validateConcessionUpdate } =
		/** @type {typeof import('../src/lib/playbook/validation.ts')} */ (
			await server.ssrLoadModule('/src/lib/playbook/validation.ts')
		);
	const identity = {
		issuer: 'https://seed-verifier.invalid',
		subject: 'seed-user',
		tokenIdentifier: 'https://seed-verifier.invalid|seed-user',
		email: 'seed@seed-verifier.invalid',
		emailVerified: true
	};
	for (const [i, item] of items.entries()) {
		// Use a real typed Convex context rather than claiming a sparse object is MutationCtx.
		// This harness is entirely in memory and has no deployment connection.
		const harness = convexTest(schema, modules).withIdentity(identity);
		const { companyId, membershipId } = await harness.run(async (ctx) => {
			const profileId = await ctx.db.insert('profiles', {
				helpPreferences: { rep: false, buyer: false },
				identity: identity.tokenIdentifier,
				issuer: identity.issuer,
				clerkId: identity.subject,
				email: identity.email,
				name: 'Seed verifier'
			});
			const companyId = await ctx.db.insert('company', {
				ownerProfileId: profileId,
				name: 'Seed company'
			});
			const membershipId = await ctx.db.insert('memberships', {
				companyId,
				profileId,
				role: 'admin'
			});
			return { companyId, membershipId };
		});
		const setup = await harness.mutation(internal.operator.bootstrap, { companyId, blocks, items });
		await harness.mutation(internal.authoringValidation.certify, {
			companyId,
			versionId: setup.versionId
		});
		const saved = await harness.run(async (ctx) => {
			const heads = await ctx.db
				.query('playbookItems')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
				.collect();
			const details = await Promise.all(heads.map((head) => hydrateHead(ctx, head)));
			return present(details.find((detail) => detail.trigger.id === item.trigger.id));
		});
		assert.ok('concessions' in saved, 'Seed round-trip requires rep instructions');
		const editing = new AuthoringContext(
			{ ...item, instructions: item.instructions ?? {} },
			saved,
			{ kind: 'editing' }
		);
		assert.deepEqual(editing.payload, item, `Edit/save loses data: ${i}`);
		validateConcessionUpdate(item, semanticRepInstruction(item));
		const result = await harness.mutation(api.playbookItems.saveTemplateItem, {
			membershipId,
			id: saved._id,
			item: editing.payload,
			expectedContentRevision: 1,
			operationId: '00000000-0000-4000-8000-000000000000'
		});
		assert.equal(result.status, 'saved', `Mutation rejected item ${i}`);
		const persisted = await harness.run(async (ctx) =>
			businessItem(await hydrateHead(ctx, present(await ctx.db.get('playbookItems', saved._id))))
		);
		assert.deepEqual(persisted, item, `Mutation drops business fields: ${i}`);
		const html = render(RepPlaybookPanel, {
			props: { item: resolveTemplateItem(saved), onToggle: () => {}, onClose: () => {} }
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
				semanticRepInstruction(item),
				semanticRepInstruction({
					...item,
					instructions: {
						...item.instructions,
						negotiation: item.instructions.negotiation + 'changed'
					}
				}),
				'Negotiation notes must affect save identity'
			);
	}
	const { ContractDocumentCompositionEngine } =
		/** @type {typeof import('../src/lib/document/contract-compose.ts')} */ (
			await server.ssrLoadModule('/src/lib/document/contract-compose.ts')
		);
	const { documentIndex, contractDocumentToRenderTransport, contractDocumentFromRenderTransport } =
		/** @type {typeof import('../src/lib/document/contract-document.ts')} */ (
			await server.ssrLoadModule('/src/lib/document/contract-document.ts')
		);
	const { composeExport } = /** @type {typeof import('../src/lib/document/export/content.ts')} */ (
		await server.ssrLoadModule('/src/lib/document/export/content.ts')
	);
	const { changeSession } = /** @type {typeof import('../src/convex/contractChanges.ts')} */ (
		await server.ssrLoadModule('/src/convex/contractChanges.ts')
	);
	const { seller } = /** @type {typeof import('../src/convex/contractState.ts')} */ (
		await server.ssrLoadModule('/src/convex/contractState.ts')
	);
	const harness = convexTest(schema, modules).withIdentity(identity);
	const { companyId, membershipId } = await harness.run(async (ctx) => {
		const profileId = await ctx.db.insert('profiles', {
			helpPreferences: { rep: false, buyer: false },
			identity: identity.tokenIdentifier,
			issuer: identity.issuer,
			clerkId: identity.subject,
			email: identity.email,
			name: 'Seed verifier'
		});
		const companyId = await ctx.db.insert('company', {
			ownerProfileId: profileId,
			name: 'Seed company'
		});
		const membershipId = await ctx.db.insert('memberships', {
			companyId,
			profileId,
			role: 'admin'
		});
		return { companyId, membershipId };
	});
	const fixture = await harness.mutation(internal.operator.bootstrap, { companyId, blocks, items });
	await harness.mutation(internal.authoringValidation.certify, {
		companyId,
		versionId: fixture.versionId
	});
	const itemIds = await harness.run(async (ctx) =>
		present(await ctx.db.get('templateVersions', fixture.versionId)).items.map(
			(item) => item.itemId
		)
	);

	// Only the approved hidden-placeholder -> virtual-gap identity changes. All other
	// block identities, placement, wording and numbering remain exact oracle checks.
	const insertionIndex = expected.manifest.items.findIndex(
		(m) => m.clauseKey === 'mutual-indemnification-insertion'
	);
	const insertionId = items[insertionIndex].concessions[0].id;

	/** @type {{name:string;selected:Record<string,string>}[]} */
	const scenarios = [{ name: 'templateSource', selected: {} }];
	items.forEach((item, i) =>
		item.concessions.forEach((c) =>
			scenarios.push({ name: c.id, selected: { [`seed-item-${i}`]: c.id } })
		)
	);
	const frozen = await readFrozenStates();
	for (const state of frozen)
		if (Object.keys(state.selected).length > 1 && !scenarios.some((s) => s.name === state.name))
			scenarios.push({ name: state.name, selected: remapSeedSelections(items, state.selected) });
	for (const { name, selected } of scenarios) {
		const old = historicalEffective(source, new Set(Object.values(selected)));
		const created = await harness.mutation(api.contracts.create, {
			membershipId,
			title: `Seed ${name}`,
			operationId: `seed:${name}`
		});
		assert.equal(created.status, 'created');
		assert.ok(created.status === 'created');
		const { document, insertionChangeId } = await harness.run(async (ctx) => {
			const { contract, access } = await seller(ctx, { membershipId, id: created.id });
			const session = await changeSession(ctx, contract);
			const document = await materializeSeedSelections(session, items, selected, itemIds, {
				access,
				templateVersionId: contract.root.templateVersionId,
				operationId: `seed:${name}`
			});
			return {
				document,
				insertionChangeId: (await session.head('playbook', present(itemIds[insertionIndex])))
					.applied?.id
			};
		});
		const aliases = new Map();
		if (selected[`seed-item-${insertionIndex}`] === insertionId) {
			const pieceKeys = new Set(
				document.pieces
					.filter((piece) => piece.createdBy === present(insertionChangeId))
					.map((piece) => piece.sourceKey)
			);
			const inserted = document.blocks.filter(
				(block) =>
					block.kind !== 'table' && block.content.some((atom) => pieceKeys.has(atom.sourceKey))
			);
			assert.equal(inserted.length, 1, 'The retained insertion must create exactly one paragraph');
			aliases.set(inserted[0].blockKey, 'paragraph-mutual-indemnification');
		}
		const rendered = contractDocumentFromRenderTransport(
			contractDocumentToRenderTransport(document)
		);
		const engine = new ContractDocumentCompositionEngine(rendered, blocks, documentIndex(rendered));
		const effective = [...engine.compose({ items: [], activeConcessions: {}, view: 'effective' })];
		const redline = [...engine.compose({ items: [], activeConcessions: {}, view: 'redline' })];
		mismatches.push(
			...differences(visible(old), visible(effective, aliases), `output/${name}/effective`)
		);
		// Word and HubSpot receive this same effective-only export, compared directly
		// with the archived wording oracle rather than another composition result.
		const exported = composeExport({ document });
		mismatches.push(
			...differences(
				visible(old).map((block) =>
					block.kind === 'table'
						? { kind: block.kind, rows: block.rows }
						: {
								kind: block.kind,
								role: block.role,
								content: present(block.content)
									.map((run) => run.text)
									.join('')
									.replace(/\r\n?/gu, '\n')
							}
				),
				exported.map((block) =>
					block.kind === 'table'
						? { kind: block.kind, rows: block.rows }
						: { kind: block.kind, role: block.role, content: block.content }
				),
				`output/${name}/export`
			)
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
		retired = present(source.boxes.find((box) => box.clauseKey === retiredTableRule));
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
					'Continuous selections retain two unchanged templateSource references as structured replacement atoms.'
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
				entity: 'clauseBox → repInstruction',
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
			'Paragraph insertion uses virtual templateSource boundaries; no hidden placeholder or optional paragraph remains.',
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
			await readSeed(server, 'templateSourceBlocks'),
			await readSeed(server, 'playbookItems')
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
