// Explicitly scoped role proposals and reversible development/local migration.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { readSeed } from './reconcile-production-seed.mjs';
import { companyDeployment } from './company-convex.mjs';

/** @typedef {{operation:'apply'|'rollback', fingerprint:string}} RoleOperation */
/** @typedef {Record<string,unknown> & {version:1, companyId:string, deployment:string, templateSourceId:string, sourceFingerprint:string, expectedFingerprint:string, resultFingerprint:string, assignments:import('../src/lib/document/source-model').RoleAssignment[], previous:import('../src/lib/document/source-model').RoleAssignment[], pending?:RoleOperation, lastOperation?:RoleOperation}} RoleManifest */

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is import('../src/lib/document/source-model').RoleAssignment[]} */
function roleAssignments(value) {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				record(entry) &&
				typeof entry.blockKey === 'string' &&
				(entry.role === 'title' || entry.role === 'heading' || entry.role === 'body')
		)
	);
}

/** @param {unknown} value @returns {value is RoleOperation} */
function roleOperation(value) {
	return (
		record(value) &&
		(value.operation === 'apply' || value.operation === 'rollback') &&
		typeof value.fingerprint === 'string'
	);
}

/** @param {unknown} value @returns {value is RoleManifest} */
function roleManifest(value) {
	return (
		record(value) &&
		value.version === 1 &&
		typeof value.companyId === 'string' &&
		typeof value.deployment === 'string' &&
		typeof value.templateSourceId === 'string' &&
		typeof value.sourceFingerprint === 'string' &&
		typeof value.expectedFingerprint === 'string' &&
		typeof value.resultFingerprint === 'string' &&
		roleAssignments(value.assignments) &&
		roleAssignments(value.previous) &&
		(value.pending === undefined || roleOperation(value.pending)) &&
		(value.lastOperation === undefined || roleOperation(value.lastOperation))
	);
}

const [command, ...args] = process.argv.slice(2);
/** @type {Map<string,string>} */
const options = new Map();
let manual = false;
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--manual') {
		if (manual) throw new Error('Duplicate --manual.');
		manual = true;
		continue;
	}
	if (
		!['--company-id', '--template-source-id', '--deployment', '--file', '--seed-items'].includes(
			args[i]
		) ||
		options.has(args[i]) ||
		!args[i + 1] ||
		args[i + 1].startsWith('--')
	)
		throw new Error('Invalid or duplicate role migration option.');
	options.set(args[i], args[++i]);
}
const companyId = options.get('--company-id'),
	deployment = options.get('--deployment'),
	file = options.get('--file');
if (
	(command !== 'plan' && command !== 'apply' && command !== 'rollback') ||
	!companyId ||
	!deployment ||
	!file ||
	(command === 'plan' && !options.get('--template-source-id')) ||
	(manual && command !== 'plan')
)
	throw new Error(
		'Usage: node scripts/template-source-roles.mjs plan|apply|rollback --company-id ID --deployment dev:EXACT_NAME --file PATH [--template-source-id ID] [--manual] [--seed-items PATH]'
	);
const target = await companyDeployment({
	companyId,
	paragraphRoles: true,
	readOnly: command === 'plan'
});
if (target.deployment !== deployment)
	throw new Error(
		'The explicit deployment does not match the configured target. No operation was run.'
	);
const run = target.run;
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
	const { canonicalFingerprint, templateSourceIntegrity } =
		/** @type {typeof import('../src/convex/templateSourceStorage.ts')} */ (
			await server.ssrLoadModule('/src/convex/templateSourceStorage.ts')
		);
	const { documentSource } =
		/** @type {typeof import('../src/lib/document/paragraph-migration.ts')} */ (
			await server.ssrLoadModule('/src/lib/document/paragraph-migration.ts')
		);
	const { assignParagraphRoles } = /** @type {typeof import('../src/lib/document/roles.ts')} */ (
		await server.ssrLoadModule('/src/lib/document/roles.ts')
	);
	const { composeExport } = /** @type {typeof import('../src/lib/document/export/content.ts')} */ (
		await server.ssrLoadModule('/src/lib/document/export/content.ts')
	);
	if (command === 'plan') {
		const templateSourceId = options.get('--template-source-id');
		if (!templateSourceId) throw new Error('Missing template source ID.');
		const existing = await run('templateSourceFormatting:inspectSource', {
			companyId,
			templateSourceId
		});
		const previous = existing.blocks.flatMap((block) =>
			block.kind === 'paragraph' ? [{ blockKey: block.blockKey, role: block.role }] : []
		);
		let assignments = previous;
		/** @type {import('./operator-types').OperatorResult<'templateSourceParser:analyzeExisting'>['decisions']} */
		let decisions = [];
		if (!manual && existing.source === 'docx') {
			({ assignments, decisions } = await run('templateSourceParser:analyzeExisting', {
				companyId,
				templateSourceId,
				expectedFingerprint: existing.fingerprint
			}));
		} else if (!manual) {
			const seed = await readSeed(server, 'templateSourceBlocks');
			if (canonicalFingerprint(documentSource(seed)) !== existing.sourceFingerprint)
				throw new Error(
					'The checked-in seed does not exactly match this template source. Use --manual to prepare an explicit review.'
				);
			assignments = seed.flatMap((block) =>
				block.kind === 'paragraph' ? [{ blockKey: block.blockKey, role: block.role }] : []
			);
		}
		const reviewed = assignParagraphRoles(existing.blocks, assignments);
		const output = composeExport({ blocks: existing.blocks, items: [], activeConcessions: {} });
		const decisionMap = new Map(decisions.map((decision) => [decision.blockKey, decision]));
		const manifest = {
			version: 1,
			companyId,
			templateSourceId,
			deployment,
			sourceFingerprint: existing.sourceFingerprint,
			expectedFingerprint: existing.fingerprint,
			previous,
			assignments,
			resultFingerprint: templateSourceIntegrity(reviewed).fingerprint,
			preview: existing.blocks.flatMap((block, index) =>
				block.kind === 'paragraph'
					? [
							{
								blockKey: block.blockKey,
								current: block.role,
								proposed: reviewed[index].kind === 'paragraph' ? reviewed[index].role : undefined,
								text:
									output[index]?.kind === 'table'
										? ''
										: (output[index]?.content.slice(0, 180) ?? ''),
								...decisionMap.get(block.blockKey)
							}
						]
					: []
			)
		};
		await writeFile(resolve(file), JSON.stringify(manifest, null, 2) + '\n', {
			flag: 'wx',
			mode: 0o600
		});
		console.log(
			`Role proposal saved to ${resolve(file)}. Review assignments before applying; no database data was changed.`
		);
	} else {
		const manifest = /** @type {unknown} */ (JSON.parse(await readFile(resolve(file), 'utf8')));
		if (
			!roleManifest(manifest) ||
			manifest.companyId !== companyId ||
			manifest.deployment !== deployment ||
			(options.has('--template-source-id') &&
				manifest.templateSourceId !== options.get('--template-source-id'))
		)
			throw new Error('The manifest does not match the explicit migration scope.');
		const templateSourceId = manifest.templateSourceId;
		const existing = await run('templateSourceFormatting:inspectSource', {
			companyId,
			templateSourceId
		});
		if (existing.sourceFingerprint !== manifest.sourceFingerprint)
			throw new Error('Contract source changed. Reanalyze it before repairing roles.');
		const assignments = command === 'apply' ? manifest.assignments : manifest.previous;
		const fingerprint = templateSourceIntegrity(
			assignParagraphRoles(existing.blocks, assignments)
		).fingerprint;
		const expectedFingerprint =
			command === 'apply'
				? manifest.lastOperation?.operation === 'rollback'
					? manifest.lastOperation.fingerprint
					: manifest.expectedFingerprint
				: manifest.resultFingerprint;
		if (existing.fingerprint !== expectedFingerprint && existing.fingerprint !== fingerprint)
			throw new Error('TemplateSource roles changed outside this manifest. Review it again.');
		if (command === 'apply') manifest.resultFingerprint = fingerprint;
		const saveManifest = async () => {
			const temporary = `${resolve(file)}.pending`;
			await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
			await rename(temporary, resolve(file));
		};
		manifest.pending = { operation: command, fingerprint };
		await saveManifest();
		const seedItems = await readSeed(server, 'playbookItems', options.get('--seed-items'));
		await run('templateSourceFormatting:repairSource', {
			companyId,
			templateSourceId,
			expectedFingerprint,
			sourceFingerprint: manifest.sourceFingerprint,
			resultFingerprint: fingerprint,
			assignments,
			...(existing.source === 'seed' ? { seedItems } : {})
		});
		for (const name of /** @type {const} */ ([
			'normalizeSources',
			'normalizeDetachedChunks',
			'recountVersions'
		])) {
			/** @type {string|null} */
			let cursor = null;
			while (true) {
				/** @type {import('./operator-types').OperatorResult<`templateSourceFormatting:${typeof name}`>} */
				const result = await run(`templateSourceFormatting:${name}`, {
					companyId,
					cursor,
					...(name === 'normalizeSources' ? { seedItems } : {})
				});
				if (result.done) break;
				if (result.cursor === cursor) throw new Error('Migration cursor did not advance.');
				cursor = result.cursor;
			}
		}
		delete manifest.pending;
		manifest.lastOperation = { operation: command, fingerprint };
		await saveManifest();
		console.log(
			`Role ${command} and company accounting completed. Restore strict schema and reload clients before normal operation.`
		);
	}
} finally {
	await server.close();
}
