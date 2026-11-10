// Explicit personal-dev operator. Does not deploy or accept production targets.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { configuredEnv } from './convex-env.mjs';
const args = process.argv.slice(2);
const name = args[1];
if (
	args.length !== 2 ||
	args[0] !== '--deployment' ||
	!/^[a-z][a-z0-9-]{2,80}$/.test(name ?? '') ||
	['dev', 'prod', 'local'].includes(name)
)
	throw new Error(
		'Usage: node scripts/migrate-template-terminology.mjs --deployment EXACT_DEV_NAME'
	);
const env = await configuredEnv('CONVEX_DEPLOYMENT', 'PUBLIC_CONVEX_URL', 'CONVEX_DEPLOY_KEY');
if (
	env.CONVEX_DEPLOYMENT !== `dev:${name}` ||
	env.PUBLIC_CONVEX_URL !== `https://${name}.convex.cloud`
)
	throw new Error(
		'This operator requires the exact configured personal development deployment. Production is refused.'
	);
if (env.CONVEX_DEPLOY_KEY && !env.CONVEX_DEPLOY_KEY.startsWith(`dev:${name}|`))
	throw new Error('The configured deployment key targets a different deployment.');
console.log(
	`target: dev (${name}, personal dev); migrate template terminology across this deployment`
);
let previous;
for (let calls = 1; ; calls++) {
	let result;
	try {
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				fileURLToPath(new URL('../node_modules/convex/bin/main.js', import.meta.url)),
				'run',
				'terminologyMigration:step',
				'{}',
				'--deployment',
				name
			],
			{ timeout: 60_000, maxBuffer: 1024 * 1024, encoding: 'utf8' }
		);
		result = JSON.parse(stdout);
	} catch {
		throw new Error(
			'Terminology migration stopped. Inspect this exact deployment, then rerun to resume durable progress. No automatic retry was performed.'
		);
	}
	if (typeof result.phase !== 'string' || typeof result.done !== 'boolean')
		throw new Error('Unexpected migration result.');
	if (result.phase !== previous || calls % 100 === 0)
		console.log(`${result.phase}: ${calls} bounded transactions`);
	previous = result.phase;
	if (result.done) break;
}
console.log(
	'Migration complete. Restore and deploy the strict canonical schema before resuming app access.'
);
