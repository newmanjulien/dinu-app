import { convexToJson, jsonToConvex } from 'convex/values';
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

export async function companyDeployment({ companyId, readOnly = false }) {
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
				: 'Seeding requires a configured development or local deployment.'
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
	const keyParts = key?.split('|');
	if (
		!key ||
		(kind !== 'local' &&
			(keyParts.length !== 2 || keyParts[0] !== `${kind}:${name}` || !keyParts[1]))
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
		async run(functionName, args) {
			const operation =
				functionName === 'operator:readSeed'
					? 'query'
					: !readOnly && functionName === 'operator:bootstrap'
						? 'mutation'
						: null;
			if (!operation || args.companyId !== companyId)
				throw new Error('This operator allows only its explicitly scoped seed functions.');
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
