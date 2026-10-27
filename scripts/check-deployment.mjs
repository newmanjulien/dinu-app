import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parsePublishableKey } from '@clerk/shared/keys';
import { Webhook } from 'svix';

const deployment = 'befitting-lyrebird-846';
const convexUrl = `https://${deployment}.convex.cloud`;
const appUrl = 'https://dinu.juliennewman.com';
const clerkHost = 'clerk.dinu.juliennewman.com';
const issuer = `https://${clerkHost}`;
const instanceId = 'ins_3LFqe1zQR22UO50Z6le0kuij55b';
const fetch = globalThis.fetch;
const timeoutMs = 15_000;
let stage = 'production environment';

function requireValue(condition) {
	if (!condition) throw Object.assign(new Error('Configuration mismatch'), { status: 400 });
}

function requiredEnv(name) {
	const value = process.env[name];
	requireValue(typeof value === 'string' && value.trim().length > 0);
	return value;
}

async function boundedFetch(input, init = {}) {
	return fetch(input, {
		...init,
		redirect: 'error',
		signal: init.signal
			? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs)
	});
}

async function request(operation) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await operation();
		} catch (error) {
			const transient = error.status === undefined || error.status === 429 || error.status >= 500;
			if (!transient || attempt === 2) throw error;
			await delay(250 * 2 ** attempt);
		}
	}
}

async function readConvexEnv(name) {
	stage = `Convex ${name} (requires deployment-key environment read access)`;
	return request(async () => {
		const result = spawnSync(
			process.execPath,
			['node_modules/convex/bin/main.js', 'env', 'get', name],
			{
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 30_000,
				maxBuffer: 1024 * 1024
			}
		);
		if (result.error || result.status !== 0) {
			// Captured CLI output can contain credentials. Classify it privately and never print it.
			const transient =
				result.error?.code === 'ETIMEDOUT' ||
				/ECONN|ENOTFOUND|EAI_AGAIN|timed? ?out|HTTP (429|5\d\d)/i.test(result.stderr ?? '');
			throw Object.assign(new Error('Unable to read deployment environment'), {
				status: transient ? 503 : 400
			});
		}
		const value = result.stdout.trim();
		requireValue(value.length > 0);
		return value;
	});
}

async function httpResponse(url, init, expectedStatus, readJson = false) {
	return request(async () => {
		const response = await boundedFetch(url, init);
		if (response.status !== expectedStatus) {
			await response.body?.cancel();
			throw Object.assign(new Error('Unexpected HTTP status'), { status: response.status });
		}
		return readJson ? response.json() : response;
	});
}

try {
	requireValue(process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'production');
	stage = 'Convex production deployment and URL';
	requireValue(requiredEnv('CONVEX_DEPLOY_KEY').startsWith(`prod:${deployment}|`));
	requireValue(requiredEnv('PUBLIC_CONVEX_URL') === convexUrl);

	stage = 'Clerk production API keys';
	const secretKey = requiredEnv('CLERK_SECRET_KEY');
	const publishableKey = requiredEnv('PUBLIC_CLERK_PUBLISHABLE_KEY');
	requireValue(secretKey.startsWith('sk_live_') && publishableKey.startsWith('pk_live_'));
	requireValue(parsePublishableKey(publishableKey, { fatal: true }).frontendApi === clerkHost);

	// This SDK version captures fetch at import time. Bound its requests before loading it,
	// then restore the process global; the deployment checker owns this short-lived process.
	globalThis.fetch = boundedFetch;
	let createClerkClient;
	try {
		({ createClerkClient } = await import('@clerk/backend'));
	} finally {
		globalThis.fetch = fetch;
	}
	const clerk = createClerkClient({ secretKey, publishableKey, telemetry: { disabled: true } });
	stage = 'Clerk production instance';
	const instance = await request(() => clerk.instance.get());
	requireValue(instance.id === instanceId && instance.environmentType === 'production');
	stage = 'Clerk domain belongs to the production instance';
	const domains = await request(() => clerk.domains.list());
	requireValue(
		domains.data.some(
			(domain) => domain.name === new URL(appUrl).hostname && domain.frontendApiUrl === issuer
		)
	);

	const backendSecret = await readConvexEnv('CLERK_SECRET_KEY');
	stage = 'Vercel and Convex Clerk secrets match';
	requireValue(backendSecret === secretKey);
	const backendIssuer = await readConvexEnv('CLERK_JWT_ISSUER_DOMAIN');
	stage = 'Convex Clerk JWT issuer';
	requireValue(backendIssuer === issuer);
	const backendAppUrl = await readConvexEnv('APP_URL');
	stage = 'Convex application URL';
	requireValue(backendAppUrl === appUrl);
	const webhookSecret = await readConvexEnv('CLERK_WEBHOOK_SIGNING_SECRET');

	stage = 'Clerk convex JWT template audience and standard signing';
	const templates = await request(() => clerk.jwtTemplates.list({ limit: 100 }));
	const template = templates.data.find((item) => item.name === 'convex');
	requireValue(
		template?.claims.aud === 'convex' &&
			template.customSigningKey === false &&
			template.signingAlgorithm === 'RS256'
	);
	stage = 'Clerk OpenID discovery issuer';
	const discovery = await httpResponse(`${issuer}/.well-known/openid-configuration`, {}, 200, true);
	requireValue(discovery.issuer === issuer);

	stage = 'Convex Clerk webhook rejects unsigned events';
	const webhookUrl = `https://${deployment}.convex.site/clerk/webhook`;
	const body = JSON.stringify({ type: 'configuration.check' });
	const unsigned = await httpResponse(
		webhookUrl,
		{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
		400
	);
	await unsigned.body?.cancel();
	stage = 'Convex Clerk webhook accepts signed inert events';
	const webhook = new Webhook(webhookSecret);
	const id = `configuration-check-${randomUUID()}`;
	const timestamp = new Date();
	await httpResponse(
		webhookUrl,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'svix-id': id,
				'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
				'svix-signature': webhook.sign(id, timestamp, body)
			},
			body
		},
		204
	);
	console.log(
		'Production deployment checks passed: Vercel, Convex, Clerk, JWT, and webhook signatures.'
	);
} catch {
	// Do not print exceptions from SDKs, child processes, or HTTP responses: they may contain secrets.
	console.error(`Deployment check failed: ${stage}. Check the production settings and retry.`);
	process.exitCode = 1;
}
