import { insertTestConnection } from './hubspot-credentials';
import { fixtureOperationId } from './operation';
/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import rateLimiter from '@convex-dev/rate-limiter/test';
import workpool from '@convex-dev/workpool/test';
import type { WorkId } from '@convex-dev/workpool';
import { afterEach, beforeEach, vi } from 'vitest';
import { api, internal } from '../../src/convex/_generated/api';
import type { Doc, Id } from '../../src/convex/_generated/dataModel';
import schema from '../../src/convex/schema';
import { readContract } from '../../src/convex/contractState';
import { block, identity, initializeViewer, item } from './contract-data';

export { api, internal, identity };
export const NOW = Date.parse('2026-11-07T12:00:00Z');
export const HOUR = 60 * 60_000;
export const bytes = new TextEncoder().encode('Exact synthetic DOCX bytes');
export const json = (value: unknown, status = 200, headers?: HeadersInit) =>
	new Response(JSON.stringify(value), { status, headers });

export function integrationClock() {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		for (const key of ['HUBSPOT_ENABLED', 'HUBSPOT_DELIVERY_ENABLED']) vi.stubEnv(key, 'true');
		vi.stubEnv('APP_URL', 'https://dinu.example');
		vi.stubEnv('HUBSPOT_CLIENT_ID', 'synthetic-client');
		vi.stubEnv('HUBSPOT_CLIENT_SECRET', 'synthetic-secret');
		vi.stubEnv('HUBSPOT_REDIRECT_URI', 'https://dinu.example/api/hubspot/callback');
		vi.stubEnv('HUBSPOT_SCOPES', 'oauth crm.objects.deals.read files.read files.write');
		// Never allow an unmocked request to reach a real provider.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('Unexpected network request');
			})
		);
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});
}

export async function fixture({
	blocks = [block],
	items = [item]
}: {
	blocks?: import('../../src/lib/document/source-model').SourceBlock[];
	items?: (typeof item)[];
} = {}) {
	const root = convexTest(schema, import.meta.glob('../../src/convex/**/*.*s'));
	rateLimiter.register(root);
	workpool.register(root, 'hubspotPool');
	const t = root.withIdentity(identity);
	const owner = await t.run(initializeViewer);
	const setup = await t.mutation(internal.operator.bootstrap, {
		companyId: owner.companyId,
		blocks,
		items: items.map((item) => ({
			...item,
			approvalPolicy: { kind: 'required' as const, instructions: 'Ask first.' }
		}))
	});
	await t.mutation(internal.authoringValidation.certify, {
		companyId: owner.companyId,
		versionId: setup.versionId
	});
	const itemId = await t.run(
		async ({ db }) =>
			(await db
				.query('playbookItems')
				.withIndex('by_companyId_and_audience', (q) => q.eq('companyId', owner.companyId))
				.unique())!._id
	);
	const connectionId = await t.run(({ db }) =>
		insertTestConnection(db, {
			companyId: owner.companyId,
			accountId: '12345',
			generation: 1,
			accessToken: 'synthetic-access',
			refreshToken: 'synthetic-refresh',
			expiresAt: NOW + 48 * HOUR,
			scopes: ['oauth'],
			installerId: owner.profileId,
			installedAt: NOW,
			status: 'connected'
		})
	);
	const creation = {
		membershipId: owner.membershipId,
		operationId: fixtureOperationId('create-linked'),
		dealId: '101',
		connectionId,
		credentialGeneration: 1,
		name: 'Original deal & contract'
	};
	const created = await t.mutation(internal.hubspotDeals.commit, creation);
	if (created.status !== 'created') throw new Error('Fixture creation failed');
	const repIdentity = {
		...identity,
		subject: 'user_other',
		tokenIdentifier: 'https://perf.clerk.accounts.dev|user_other',
		email: 'other@example.com'
	};
	const rep = await t.run(async ({ db }) => {
		const profileId = await db.insert('profiles', {
			identity: repIdentity.tokenIdentifier,
			issuer: repIdentity.issuer,
			clerkId: repIdentity.subject,
			email: repIdentity.email,
			name: 'Other member'
		});
		const membershipId = await db.insert('memberships', {
			profileId,
			companyId: owner.companyId,
			role: 'rep'
		});
		return { profileId, membershipId };
	});
	return {
		root,
		t,
		owner,
		connectionId,
		itemId,
		id: created.id,
		creation,
		rep,
		repClient: root.withIdentity(repIdentity)
	};
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export function events(f: Fixture) {
	return f.t.run(({ db }) => db.query('hubspotEvents').collect());
}
export async function event(f: Fixture) {
	return (await events(f))[0];
}
export async function enqueue(f: Fixture, id?: Id<'hubspotEvents'>) {
	const before = await f.t.run(({ db }) =>
		id ? db.get('hubspotEvents', id) : db.query('hubspotEvents').first()
	);
	if (
		!before ||
		(before.status !== 'pending' &&
			before.status !== 'uncertain' &&
			before.status !== 'working' &&
			before.status !== 'blocked')
	)
		throw new Error('Event was not queued');
	await f.t.mutation(internal.hubspotDelivery.pump, { status: before.status });
	const row = await f.t.run(({ db }) =>
		id ? db.get('hubspotEvents', id) : db.query('hubspotEvents').first()
	);
	if (!row?.execution || !row.workId) throw new Error('Event was not queued');
	return { ...row, execution: row.execution, workId: row.workId as WorkId };
}
export async function send(f: Fixture, id?: Id<'hubspotEvents'>) {
	const row = await enqueue(f, id);
	await f.t.action(internal.hubspotSender.send, { id: row._id, execution: row.execution });
	return row;
}
export async function complete(f: Fixture, row: Awaited<ReturnType<typeof enqueue>>) {
	await f.t.mutation(internal.hubspotDelivery.completed, {
		workId: row.workId,
		context: { id: row._id, execution: row.execution },
		result: { kind: 'success', returnValue: null }
	});
}
export async function claim(f: Fixture) {
	const row = await enqueue(f);
	const owned = await f.t.mutation(internal.hubspotDelivery.claim, {
		id: row._id,
		execution: row.execution,
		claim: 'owned-claim'
	});
	if (!owned) throw new Error('Claim refused');
	return { ...owned, execution: row.execution, workId: row.workId };
}

export function application(f: Fixture, operationId = 'apply', expectedStateRevision = 0) {
	return {
		membershipId: f.owner.membershipId,
		id: f.id,
		selections: { [f.itemId]: 'preferred' } as Record<Id<'playbookItems'>, string>,
		expectedStateRevision,
		operationId: fixtureOperationId(operationId)
	};
}

export async function currentContract(f: Fixture) {
	return f.t.run(async (ctx) => {
		const root = await ctx.db.get('savedContracts', f.id);
		if (!root) throw new Error('Fixture contract is missing');
		return readContract(ctx, root);
	});
}

export function exportDelivery(f: Fixture, attemptId: Id<'wordExports'>) {
	return f.t.run(({ db }) =>
		db
			.query('hubspotExportDeliveries')
			.withIndex('by_attemptId', (q) => q.eq('attemptId', attemptId))
			.unique()
	);
}

export async function readyExport(
	f: Fixture,
	operationId = 'download'
): Promise<Doc<'wordExports'>> {
	const contract = await currentContract(f);
	const fileId = await f.t.run(({ storage }) => storage.store(new Blob([bytes])));
	const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
		b.toString(16).padStart(2, '0')
	).join('');
	await f.t.mutation(internal.contractExports.commit, {
		membershipId: f.owner.membershipId,
		id: f.id,
		operationId: fixtureOperationId(operationId),
		fileId,
		sha256: hash,
		size: bytes.byteLength,
		expectedTemplateVersionId: contract.root.templateVersionId,
		expectedStateRevision: contract.root.stateRevision,
		expectedTitle: contract.root.title
	});
	const rows = await f.t.run(({ db }) =>
		db
			.query('wordExports')
			.withIndex('by_contractId', (q) => q.eq('contractId', f.id))
			.collect()
	);
	const latest = rows.at(-1);
	if (!latest) throw new Error('Expected committed word export');
	return latest;
}

export async function markUnavailable(f: Fixture) {
	const row = await claim(f);
	await f.t.mutation(internal.hubspotDelivery.settle, {
		id: row._id,
		claim: row.claim!,
		generation: 1,
		outcome: 'unavailable'
	});
	return row;
}
export function relink(f: Fixture) {
	return f.t.mutation(internal.hubspotDeals.commit, {
		...f.creation,
		operationId: fixtureOperationId('relink'),
		contractId: f.id,
		dealId: '202',
		name: 'Replacement deal',
		expectedGeneration: 1
	});
}

export async function playbookState(f: Fixture) {
	const state = await f.t.query(api.contracts.state, {
		id: f.id
	});
	if (!state) throw new Error('Fixture contract is missing');
	return state;
}

export async function decision(f: Fixture, action: 'approve' | 'decline', operationId: string) {
	const state = await playbookState(f);
	const entry = state.concessions.find((c) => c.itemId === f.itemId);
	if (!entry) throw new Error('Fixture concession is missing');
	return {
		membershipId: f.owner.membershipId,
		id: f.id,
		itemId: f.itemId,
		expectedOptionId: entry.optionId,
		expectedStateRevision: state.stateRevision,
		action,
		operationId: fixtureOperationId(operationId)
	};
}
