// Explicit development/local rehearsal runner. No deployment, reset, seed, or provider calls.
import { createServer } from 'vite';
import { configuredEnv } from './convex-env.mjs';
import { companyDeployment } from './company-convex.mjs';

const args = process.argv.slice(2);
const companyId = args[args.indexOf('--company-id') + 1];
const deployment = args[args.indexOf('--deployment') + 1];
if (
	args.length !== 4 ||
	new Set(args.filter((_, index) => index % 2 === 0)).size !== args.length / 2 ||
	args.some((arg, index) => index % 2 === 0 && !['--company-id', '--deployment'].includes(arg)) ||
	args.indexOf('--company-id') < 0 ||
	args.indexOf('--deployment') < 0 ||
	!companyId ||
	companyId.startsWith('--') ||
	!/^[a-z][a-z0-9-]{2,80}$/.test(deployment ?? '') ||
	['prod', 'dev', 'local'].includes(deployment)
)
	throw new Error(
		'Usage: node scripts/migrate-readability.mjs --company-id COMPANY_ID --deployment EXACT_NAME'
	);
const environment = await configuredEnv('CONVEX_DEPLOYMENT');
if (!['dev', 'local'].some((kind) => environment.CONVEX_DEPLOYMENT === `${kind}:${deployment}`))
	throw new Error(
		'Rehearsal requires the exact configured development/local deployment. Production is refused.'
	);

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
let tables;
try {
	tables = (await server.ssrLoadModule('/src/convex/readabilityMigration.ts')).conversionTables;
} finally {
	await server.close();
}
// Use the explicit-target, scoped HTTP transport.
const target = await companyDeployment({ companyId, readabilityConversion: true });
if (target.deployment !== environment.CONVEX_DEPLOYMENT)
	throw new Error('The configured deployment changed before conversion. No operation was run.');
async function run(name, fields) {
	try {
		return await target.run(`readabilityMigration:${name}`, { companyId, ...fields });
	} catch {
		throw new Error(
			`Conversion ${name} failed. No automatic retry; inspect the explicit target before resuming.`
		);
	}
}
console.log(`Readability rehearsal: ${deployment}, company ${companyId}`);
for (const table of tables) {
	let cursor = null,
		changed = 0;
	while (true) {
		const result = await run('convertBatch', { table, cursor });
		changed += result.changed;
		if (result.done) break;
		if (result.cursor === cursor) throw new Error('Conversion cursor did not advance.');
		cursor = result.cursor;
	}
	console.log(`${table}: ${changed} records converted`);
}
let cursor = null;
while (true) {
	const page = await run('versions', { cursor });
	for (const versionId of page.ids) {
		while (!(await run('accountVersion', { versionId })).done) {
			/* Durable progress bounds each transaction. */
		}
	}
	if (page.done) break;
	if (page.cursor === cursor) throw new Error('Version cursor did not advance.');
	cursor = page.cursor;
}
console.log(
	'Company conversion complete. Restore strict schema and verify before admitting application activity.'
);
