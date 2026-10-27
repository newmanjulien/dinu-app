import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parsePublishableKey } from '@clerk/shared/keys';
import { Webhook } from 'svix';

// Both release phases use this production target. Keep local development independent.
const deployment = 'befitting-lyrebird-846';
const appUrl = 'https://dinu.juliennewman.com';
const clerkHost = 'clerk.dinu.juliennewman.com';
const instanceId = 'ins_3LFqe1zQR22UO50Z6le0kuij55b';
const convexUrl = `https://${deployment}.convex.cloud`;
const webhookUrl = `https://${deployment}.convex.site/clerk/webhook`;
const issuer = `https://${clerkHost}`;
const appHost = new URL(appUrl).hostname;
const phase = process.argv[2];
const phaseTimeoutMs = 60_000;
const deadline = Date.now() + phaseTimeoutMs;
const cancellation = new AbortController();
const phaseSignal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(phaseTimeoutMs)]);

class CheckError extends Error {
	constructor(check, reason, retryable = false, retryAfterMs = 0) {
		super(`${check}: ${reason}`);
		this.retryable = retryable;
		this.retryAfterMs = retryAfterMs;
	}
}

function requireValue(condition, check, reason) {
	if (!condition) throw new CheckError(check, reason);
}

function envValue(environment, name, location) {
	const value = environment[name];
	const check = `${location} ${name}`;
	requireValue(typeof value === 'string' && value.length > 0, check, 'missing value');
	requireValue(value === value.trim(), check, 'remove leading or trailing whitespace');
	return value;
}

function retryAfterMs(value) {
	if (!value) return 0;
	const seconds = Number(value);
	const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
	return Number.isFinite(wait) ? Math.max(0, wait) : 0;
}

async function request(check, url, { expectedStatus = 200, json = true, ...init } = {}) {
	for (let attempt = 0; ; attempt++) {
		const signal = AbortSignal.any([phaseSignal, AbortSignal.timeout(15_000)]);
		try {
			const response = await fetch(url, {
				...init,
				redirect: 'error',
				signal
			});
			if (response.status !== expectedStatus) {
				const wait = retryAfterMs(response.headers.get('retry-after'));
				await response.body?.cancel();
				throw new CheckError(
					check,
					`HTTP ${response.status}; expected ${expectedStatus}`,
					response.status === 429 || response.status >= 500,
					wait
				);
			}
			if (!json) {
				await response.body?.cancel();
				return;
			}
			return await response.json();
		} catch (error) {
			let failure = error;
			if (!(error instanceof CheckError)) {
				// Aborting response-body reads can produce AbortError rather than TimeoutError.
				const timeout = signal.aborted || error?.name === 'TimeoutError';
				const network = [
					'ECONNRESET',
					'ECONNREFUSED',
					'ENOTFOUND',
					'EAI_AGAIN',
					'ETIMEDOUT',
					'UND_ERR_CONNECT_TIMEOUT',
					'UND_ERR_HEADERS_TIMEOUT',
					'UND_ERR_BODY_TIMEOUT',
					'UND_ERR_SOCKET'
				].includes(error?.cause?.code);
				let reason = 'request failed';
				if (phaseSignal.aborted) reason = 'phase deadline reached or checks cancelled';
				else if (timeout) reason = 'request timed out';
				else if (network) reason = 'network request failed';
				else if (error instanceof SyntaxError) reason = 'invalid JSON response';
				failure = new CheckError(check, reason, timeout || network);
			}
			if (!failure.retryable || attempt === 2 || phaseSignal.aborted) throw failure;
			const wait = Math.max(250 * 2 ** attempt, failure.retryAfterMs);
			if (wait >= deadline - Date.now()) {
				failure.message += '; retry delay exceeds remaining phase time';
				throw failure;
			}
			try {
				await delay(wait, undefined, { signal: phaseSignal });
			} catch {
				throw new CheckError(check, 'phase deadline reached or checks cancelled');
			}
		}
	}
}

async function readConvexEnvironment(deployKey) {
	const result = await request(
		'Convex environment read (requires deployment-key environment read access)',
		`${convexUrl}/api/v1/list_environment_variables`,
		{ headers: { Authorization: `Convex ${deployKey}` } }
	);
	const environment = result?.environmentVariables;
	requireValue(
		environment && typeof environment === 'object' && !Array.isArray(environment),
		'Convex environment read',
		'expected an environmentVariables object'
	);
	return environment;
}

function clerkRequest(check, path, secretKey) {
	return request(check, `https://api.clerk.com/v1/${path}`, {
		headers: { Authorization: `Bearer ${secretKey}` }
	});
}

async function checkInstance(secretKey, location) {
	const check = `${location} Clerk production instance`;
	requireValue(secretKey.startsWith('sk_live_'), check, 'expected a production secret key');
	const instance = await clerkRequest(check, 'instance', secretKey);
	requireValue(
		instance?.id === instanceId && instance.environment_type === 'production',
		check,
		'key must belong to the configured production instance'
	);
}

function webhookSigner(environment) {
	const secret = envValue(environment, 'CLERK_WEBHOOK_SIGNING_SECRET', 'Convex');
	try {
		return new Webhook(secret);
	} catch {
		throw new CheckError('Convex CLERK_WEBHOOK_SIGNING_SECRET', 'invalid signing secret');
	}
}

async function preflight(deployKey) {
	requireValue(
		envValue(process.env, 'PUBLIC_CONVEX_URL', 'Vercel') === convexUrl,
		'Convex production URL',
		'build must use the configured production deployment'
	);
	const secretKey = envValue(process.env, 'CLERK_SECRET_KEY', 'Vercel');
	const publishableKey = envValue(process.env, 'PUBLIC_CLERK_PUBLISHABLE_KEY', 'Vercel');
	requireValue(
		publishableKey.startsWith('pk_live_') &&
			parsePublishableKey(publishableKey)?.frontendApi === clerkHost,
		'Clerk publishable key',
		'expected a production key for the configured Clerk host'
	);

	await Promise.all([
		readConvexEnvironment(deployKey).then(async (environment) => {
			const backendSecret = envValue(environment, 'CLERK_SECRET_KEY', 'Convex');
			requireValue(
				envValue(environment, 'CLERK_JWT_ISSUER_DOMAIN', 'Convex') === issuer,
				'Convex Clerk JWT issuer',
				'must match the configured Clerk issuer'
			);
			requireValue(
				envValue(environment, 'APP_URL', 'Convex') === appUrl,
				'Convex application URL',
				'must match the production website origin'
			);
			webhookSigner(environment);
			// Different active keys are valid; identical keys need only one instance lookup.
			if (backendSecret !== secretKey) await checkInstance(backendSecret, 'Convex');
		}),
		checkInstance(secretKey, 'Vercel'),
		clerkRequest('Clerk production domain', 'domains', secretKey).then((domains) => {
			requireValue(
				Array.isArray(domains?.data) &&
					domains.data.some(
						(domain) => domain?.name === appHost && domain.frontend_api_url === issuer
					),
				'Clerk production domain',
				'website domain and frontend API must match the production target'
			);
		}),
		clerkRequest(
			'Clerk convex JWT template',
			'jwt_templates?limit=100&paginated=true',
			secretKey
		).then((templates) => {
			const template = Array.isArray(templates?.data)
				? templates.data.find((item) => item?.name === 'convex')
				: undefined;
			requireValue(
				template?.claims?.aud === 'convex' &&
					template.custom_signing_key === false &&
					template.signing_algorithm === 'RS256',
				'Clerk convex JWT template',
				'requires audience convex and standard RS256 signing'
			);
			requireValue(
				template.claims.email === '{{user.primary_email_address}}' &&
					template.claims.email_verified === '{{user.email_verified}}',
				'Clerk convex JWT identity claims',
				'requires the documented email and email_verified shortcodes'
			);
		}),
		request('Clerk OpenID discovery', `${issuer}/.well-known/openid-configuration`).then(
			(discovery) => {
				requireValue(
					discovery?.issuer === issuer,
					'Clerk OpenID discovery',
					'issuer must match the production target'
				);
			}
		)
	]);
}

async function smoke(deployKey) {
	const webhook = webhookSigner(await readConvexEnvironment(deployKey));
	const body = JSON.stringify({ type: 'configuration.check' });
	const id = `configuration-check-${randomUUID()}`;
	const timestamp = new Date();
	const headers = {
		'Content-Type': 'application/json',
		'svix-id': id,
		'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000))
	};
	const init = { method: 'POST', body, json: false };
	await Promise.all([
		request('Webhook rejects missing signature', webhookUrl, {
			...init,
			headers: { 'Content-Type': 'application/json' },
			expectedStatus: 400
		}),
		request('Webhook rejects invalid signature', webhookUrl, {
			...init,
			// A well-formed signature for different bytes must fail verification.
			headers: { ...headers, 'svix-signature': webhook.sign(id, timestamp, `${body} `) },
			expectedStatus: 400
		}),
		request('Webhook accepts signed inert event', webhookUrl, {
			...init,
			headers: { ...headers, 'svix-signature': webhook.sign(id, timestamp, body) },
			expectedStatus: 204
		})
	]);
}

try {
	requireValue(
		phase === 'preflight' || phase === 'smoke',
		'Release phase',
		'expected preflight or smoke'
	);
	requireValue(
		process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'production',
		'Vercel environment',
		'checks require a production build'
	);
	const deployKey = envValue(process.env, 'CONVEX_DEPLOY_KEY', 'Vercel');
	requireValue(
		deployKey.startsWith(`prod:${deployment}|`),
		'Convex deployment key',
		'must target the configured production deployment'
	);
	await (phase === 'preflight' ? preflight(deployKey) : smoke(deployKey));
	console.log(`Production ${phase} checks passed.`);
} catch (error) {
	cancellation.abort();
	// Only our own fixed-context errors are safe to log; never print raw errors or responses.
	const reason =
		error instanceof CheckError ? error.message : 'unexpected local error while running checks';
	console.error(`Deployment ${phase === 'smoke' ? 'smoke' : 'preflight'} failed: ${reason}.`);
	if (phase === 'smoke') {
		console.error(
			'Convex has already deployed; Vercel publication is blocked. Repair and rerun the complete release.'
		);
	}
	process.exitCode = 1;
}
