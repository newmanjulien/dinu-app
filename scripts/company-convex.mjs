import { convexToJson, jsonToConvex } from 'convex/values';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { configuredEnv } from './convex-env.mjs';

export function companyArguments({ audit = false } = {}) {
	const args = process.argv.slice(2);
	const index = args.indexOf('--company-id');
	const companyId = index >= 0 ? args[index + 1] : undefined;
	const exactSeed = audit && args.includes('--seed');
	const rest = args.filter(
		(_, i) => (index < 0 || (i !== index && i !== index + 1)) && !(audit && args[i] === '--seed')
	);
	if (!companyId || companyId.startsWith('--') || rest.length) {
		throw new Error(
			`Usage: ${audit ? 'npm run db:audit -- [--seed]' : 'npm run convex:seed --'} --company-id COMPANY_ID`
		);
	}
	return { companyId, exactSeed };
}

export async function companyDeployment({
	companyId,
	readOnly = false,
	readabilityConversion = false,
	paragraphRoles = false,
	authoringMigration = false
}) {
	if (typeof companyId !== 'string' || !companyId.trim())
		throw new Error('An explicit company ID is required.');
	const {
		PUBLIC_CONVEX_URL: url,
		CONVEX_DEPLOYMENT: deployment,
		CONVEX_DEPLOY_KEY: deployKey,
		CONVEX_SELF_HOSTED_ADMIN_KEY: localKey
	} = await configuredEnv(
		'PUBLIC_CONVEX_URL',
		'CONVEX_DEPLOYMENT',
		'CONVEX_DEPLOY_KEY',
		'CONVEX_SELF_HOSTED_ADMIN_KEY'
	);
	const match = deployment?.match(/^(dev|local|prod):([^:]+)$/);
	if (!url || !match || (!readOnly && match[1] === 'prod')) {
		throw new Error(
			readOnly
				? 'Configure PUBLIC_CONVEX_URL and CONVEX_DEPLOYMENT for this audit.'
				: 'This operation requires a configured development or local deployment.'
		);
	}
	const [, kind, name] = match;
	const target = new URL(url);
	const isLocal = ['127.0.0.1', 'localhost'].includes(target.hostname);
	if (
		target.username ||
		target.password ||
		target.search ||
		target.hash ||
		target.pathname !== '/' ||
		(kind === 'local'
			? !isLocal || !['http:', 'https:'].includes(target.protocol)
			: target.protocol !== 'https:' || target.port || target.hostname !== `${name}.convex.cloud`)
	) {
		throw new Error('PUBLIC_CONVEX_URL does not match CONVEX_DEPLOYMENT. No operation was run.');
	}
	const key = kind === 'local' ? localKey : deployKey;
	// Role migrations can use an existing personal-dev CLI login, with the exact
	// validated deployment name. Other operators retain their HTTP-key requirement.
	const useDevCli = (paragraphRoles || authoringMigration) && kind === 'dev' && !key;
	const keyParts = key?.split('|');
	if (
		!useDevCli &&
		(!key ||
			(kind !== 'local' &&
				(keyParts.length !== 2 || keyParts[0] !== `${kind}:${name}` || !keyParts[1])))
	)
		throw new Error(
			kind === 'local'
				? 'Configure CONVEX_SELF_HOSTED_ADMIN_KEY for the explicit local target.'
				: 'Configure a CONVEX_DEPLOY_KEY for this exact deployment. No operation was run.'
		);
	console.log(
		`target: ${deployment} (${kind === 'prod' ? 'production, read-only' : kind === 'local' ? 'local' : 'personal dev'}), company ${companyId}`
	);
	return {
		url: target.origin,
		deployment,
		async run(functionName, args) {
			const conversionFunctions = {
				'readabilityMigration:convertBatch': 'mutation',
				'readabilityMigration:versions': 'query',
				'readabilityMigration:accountVersion': 'mutation'
			};
			const roleFunctions = {
				'contractFormatting:inspectBaseline': 'query',
				'baselineParser:analyzeExisting': 'action',
				'contractFormatting:repairBaseline': 'mutation',
				'contractFormatting:normalizeBaselines': 'mutation',
				'contractFormatting:normalizeDetachedChunks': 'mutation',
				'contractFormatting:recountVersions': 'mutation'
			};
			const authoringFunctions = new Set([
				'authoringMigration:begin',
				'authoringMigration:step',
				'authoringMigration:finish'
			]);
			const operation = authoringMigration
				? !readOnly && authoringFunctions.has(functionName)
					? 'mutation'
					: null
				: paragraphRoles
					? Object.hasOwn(roleFunctions, functionName) &&
						(!readOnly || roleFunctions[functionName] !== 'mutation')
						? roleFunctions[functionName]
						: null
					: readabilityConversion
						? !readOnly && Object.hasOwn(conversionFunctions, functionName)
							? conversionFunctions[functionName]
							: null
						: functionName === 'operator:readSeed'
							? 'query'
							: !readOnly && functionName === 'operator:bootstrap'
								? 'mutation'
								: null;
			if (!operation || args.companyId !== companyId)
				throw new Error('This operator allows only its explicitly scoped functions.');
			if (useDevCli) {
				const { stdout } = await promisify(execFile)(
					process.execPath,
					[
						fileURLToPath(new URL('../node_modules/convex/bin/main.js', import.meta.url)),
						'run',
						functionName,
						JSON.stringify(convexToJson(args)),
						'--deployment',
						name
					],
					{ timeout: 60_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }
				);
				return jsonToConvex(JSON.parse(stdout));
			}
			// Convex's function HTTP protocol and public value codec avoid CLI login,
			// implicit targets, provisioning, command-line payloads and automatic retries.
			const response = await fetch(`${target.origin}/api/${operation}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Convex ${key}` },
				body: JSON.stringify({
					path: functionName,
					format: 'convex_encoded_json',
					args: [convexToJson(args)]
				}),
				redirect: 'error',
				signal: AbortSignal.timeout(60_000)
			});
			if (!response.ok && response.status !== 605)
				throw new Error(`${functionName} failed: HTTP ${response.status}.`);
			const result = await response.json();
			if (result.status === 'error')
				throw new Error(`${functionName} failed: ${result.errorMessage}`);
			if (!response.ok || result.status !== 'success')
				throw new Error(`${functionName} returned an invalid response.`);
			return jsonToConvex(result.value);
		}
	};
}
