// Explicitly scoped role proposals and reversible development/local migration.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { companyDeployment } from './company-convex.mjs';

const [command, ...args] = process.argv.slice(2);
const options = new Map();
let manual = false;
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--manual') {
		if (manual) throw new Error('Duplicate --manual.');
		manual = true;
		continue;
	}
	if (
		!['--company-id', '--baseline-id', '--deployment', '--file', '--seed-items'].includes(
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
	!['plan', 'apply', 'rollback'].includes(command) ||
	!companyId ||
	!deployment ||
	!file ||
	(command === 'plan' && !options.get('--baseline-id')) ||
	(manual && command !== 'plan')
)
	throw new Error(
		'Usage: node scripts/contract-roles.mjs plan|apply|rollback --company-id ID --deployment dev:EXACT_NAME --file PATH [--baseline-id ID] [--manual] [--seed-items PATH]'
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
const run = (name, fields) => target.run(name, { companyId, ...fields });
const rows = async (path) =>
	(await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
	const { canonicalFingerprint, baselineIntegrity } = await server.ssrLoadModule(
		'/src/convex/baselineStorage.ts'
	);
	const { contractSource } = await server.ssrLoadModule('/src/lib/contract/paragraph-migration.ts');
	const { assignParagraphRoles } = await server.ssrLoadModule('/src/lib/contract/roles.ts');
	const { composeExport } = await server.ssrLoadModule('/src/lib/contract/export/content.ts');
	if (command === 'plan') {
		const baselineId = options.get('--baseline-id');
		const existing = await run('contractFormatting:inspectBaseline', { baselineId });
		const previous = existing.blocks.flatMap((block) =>
			block.kind === 'paragraph' ? [{ blockKey: block.blockKey, role: block.role }] : []
		);
		let assignments = previous,
			decisions = [];
		if (!manual && existing.source === 'docx') {
			({ assignments, decisions } = await run('baselineParser:analyzeExisting', {
				baselineId,
				expectedFingerprint: existing.fingerprint
			}));
		} else if (!manual) {
			const seed = await rows('data/convex/contractBlocks.jsonl');
			if (canonicalFingerprint(contractSource(seed)) !== existing.sourceFingerprint)
				throw new Error(
					'The checked-in seed does not exactly match this baseline. Use --manual to prepare an explicit review.'
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
			baselineId,
			deployment,
			sourceFingerprint: existing.sourceFingerprint,
			expectedFingerprint: existing.fingerprint,
			previous,
			assignments,
			resultFingerprint: baselineIntegrity(reviewed).fingerprint,
			preview: existing.blocks.flatMap((block, index) =>
				block.kind === 'paragraph'
					? [
							{
								blockKey: block.blockKey,
								current: block.role,
								proposed: reviewed[index].role,
								text: output[index]?.content?.slice(0, 180) ?? '',
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
		const manifest = JSON.parse(await readFile(resolve(file), 'utf8'));
		if (
			manifest.version !== 1 ||
			manifest.companyId !== companyId ||
			manifest.deployment !== deployment ||
			(options.has('--baseline-id') && manifest.baselineId !== options.get('--baseline-id'))
		)
			throw new Error('The manifest does not match the explicit migration scope.');
		const baselineId = manifest.baselineId;
		const existing = await run('contractFormatting:inspectBaseline', { baselineId });
		if (existing.sourceFingerprint !== manifest.sourceFingerprint)
			throw new Error('Contract source changed. Reanalyze it before repairing roles.');
		const assignments = command === 'apply' ? manifest.assignments : manifest.previous;
		const fingerprint = baselineIntegrity(
			assignParagraphRoles(existing.blocks, assignments)
		).fingerprint;
		const expectedFingerprint =
			command === 'apply'
				? manifest.lastOperation?.operation === 'rollback'
					? manifest.lastOperation.fingerprint
					: manifest.expectedFingerprint
				: manifest.resultFingerprint;
		if (existing.fingerprint !== expectedFingerprint && existing.fingerprint !== fingerprint)
			throw new Error('Baseline roles changed outside this manifest. Review it again.');
		if (command === 'apply') manifest.resultFingerprint = fingerprint;
		const saveManifest = async () => {
			const temporary = `${resolve(file)}.pending`;
			await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
			await rename(temporary, resolve(file));
		};
		manifest.pending = { operation: command, fingerprint };
		await saveManifest();
		const seedItems = await rows(options.get('--seed-items') ?? 'data/convex/playbookItems.jsonl');
		await run('contractFormatting:repairBaseline', {
			baselineId,
			expectedFingerprint,
			sourceFingerprint: manifest.sourceFingerprint,
			resultFingerprint: fingerprint,
			assignments,
			...(existing.source === 'seed' ? { seedItems } : {})
		});
		for (const name of ['normalizeBaselines', 'normalizeDetachedChunks', 'recountVersions']) {
			let cursor = null;
			while (true) {
				const result = await run(`contractFormatting:${name}`, {
					cursor,
					...(name === 'normalizeBaselines' ? { seedItems } : {})
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
