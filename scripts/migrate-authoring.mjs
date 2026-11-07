// Explicit development/local rehearsal. This script never deploys, resets, seeds or targets prod.
import { configuredEnv } from './convex-env.mjs';
import { companyDeployment } from './company-convex.mjs';

const args = process.argv.slice(2);
const companyId = args[args.indexOf('--company-id') + 1];
const deployment = args[args.indexOf('--deployment') + 1];
if (
	args.length !== 4 ||
	new Set(args.filter((_, index) => index % 2 === 0)).size !== 2 ||
	args.some((arg, index) => index % 2 === 0 && !['--company-id', '--deployment'].includes(arg)) ||
	!companyId ||
	companyId.startsWith('--') ||
	!/^[a-z][a-z0-9-]{2,80}$/.test(deployment ?? '') ||
	['prod', 'dev', 'local'].includes(deployment)
)
	throw new Error(
		'Usage: node scripts/migrate-authoring.mjs --company-id COMPANY_ID --deployment EXACT_NAME'
	);
const environment = await configuredEnv('CONVEX_DEPLOYMENT');
if (!['dev', 'local'].some((kind) => environment.CONVEX_DEPLOYMENT === `${kind}:${deployment}`))
	throw new Error(
		'Authoring rehearsal requires the exact configured development/local deployment. Production is refused.'
	);
const target = await companyDeployment({ companyId, authoringMigration: true });
if (target.deployment !== environment.CONVEX_DEPLOYMENT)
	throw new Error('The configured deployment changed. No migration was run.');
async function run(name) {
	try {
		return await target.run(`authoringMigration:${name}`, { companyId });
	} catch {
		throw new Error(
			`Authoring ${name} failed. Inspect the explicit target, then rerun to resume durable progress; no automatic retry was performed.`
		);
	}
}
let progress = await run('begin');
let calls = 0;
while (progress.state !== 'complete') {
	progress = await run(progress.state === 'certify' ? 'finish' : 'step');
	if (++calls % 100 === 0 || progress.state === 'certify')
		console.log(
			`Authoring ${progress.state}: ${progress.nextItem}/${progress.itemCount} heads; ${calls} bounded transactions`
		);
}
console.log(
	'Authoring migration certified and activated. Existing item IDs and historical business snapshots are preserved.'
);
