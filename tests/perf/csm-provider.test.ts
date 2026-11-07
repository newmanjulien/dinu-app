// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import rateLimiter from '@convex-dev/rate-limiter/test';
import { api, internal } from '../../src/convex/_generated/api';
import schema from '../../src/convex/schema';
import { EVENT_ID, EVENT_SLUG, HOST } from '../../src/convex/csmCal';
import { identity, initializeViewer } from './fixtures';
const modules = import.meta.glob('../../src/convex/**/*.*s');
const now = new Date('2026-11-06T12:00:00Z');
const start = '2026-11-07T12:00:00.000Z';
const event = {
	id: EVENT_ID,
	slug: EVENT_SLUG,
	users: [{ username: HOST }],
	lengthInMinutes: 30,
	price: 0,
	bookingFields: [],
	locations: [{ type: 'integration', integration: 'google-meet' }]
};
const response = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }));
const times = { '2026-11-07': [{ start, end: '2026-11-07T12:30:00.000Z' }] };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
async function fixture() {
	const root = convexTest(schema, modules);
	rateLimiter.register(root);
	const t = root.withIdentity(identity);
	const owner = await t.run(initializeViewer);
	const args = {
		membershipId: owner.membershipId,
		mode: 'setup' as const,
		month: '2026-11',
		timeZone: 'UTC'
	};
	return { t, owner, args };
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	vi.stubEnv('CAL_API_KEY', 'synthetic');
	vi.stubEnv('CAL_WEBHOOK_SECRET', 'synthetic');
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});
it('dispatches configuration and slots together before either resolves, omitting display duration', async () => {
	const { t, args } = await fixture();
	const config = deferred<Response>(),
		slots = deferred<Response>(),
		dispatched = deferred<void>();
	const urls: URL[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((input: string) => {
			const url = new URL(input);
			urls.push(url);
			if (urls.length === 2) dispatched.resolve();
			return url.pathname.includes('event-types') ? config.promise : slots.promise;
		})
	);
	const read = t.action(api.csmBookings.availability, args);
	await dispatched.promise;
	expect(urls).toHaveLength(2);
	expect(urls.find((u) => u.pathname.endsWith('/slots'))?.searchParams.has('duration')).toBe(false);
	config.resolve(response(event));
	slots.resolve(response(times));
	expect((await read).slots).toHaveLength(1);
});
it('returns unusable configuration promptly while slots remain pending', async () => {
	const { t, args } = await fixture();
	const slow = deferred<Response>();
	vi.stubGlobal(
		'fetch',
		vi.fn((input: string) =>
			input.includes('event-types')
				? Promise.resolve(response({ ...event, price: 10 }))
				: slow.promise
		)
	);
	expect((await t.action(api.csmBookings.availability, args)).status).toBe('unavailable');
	slow.resolve(response(times));
});
it('rejects ranges with a different duration than the validated event', async () => {
	const { t, args } = await fixture();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string) =>
			response(
				input.includes('event-types')
					? event
					: { '2026-11-07': [{ start, end: '2026-11-07T13:00:00.000Z' }] }
			)
		)
	);
	await expect(t.action(api.csmBookings.availability, args)).rejects.toThrow('duration');
});
it('allows pre-baseline setup display but still refuses new booking; foreign, rep and support reads call no provider', async () => {
	const { t, owner, args } = await fixture();
	const fetcher = vi.fn(async (input: string) =>
		response(input.includes('event-types') ? event : times)
	);
	vi.stubGlobal('fetch', fetcher);
	expect((await t.action(api.csmBookings.availability, args)).status).toBe('ready');
	await expect(
		t.mutation(api.csmBookings.book, {
			membershipId: owner.membershipId,
			mode: 'setup',
			start,
			timeZone: 'UTC',
			operationId: 'synthetic-operation',
			receiptProtocol: 'creation-v1'
		})
	).rejects.toThrow('access');
	fetcher.mockClear();
	await expect(
		t.action(api.csmBookings.availability, { ...args, mode: 'support' })
	).rejects.toThrow();
	await expect(
		t
			.withIdentity({ ...identity, tokenIdentifier: 'foreign' })
			.action(api.csmBookings.availability, args)
	).rejects.toThrow();
	await t.run(async (ctx) => ctx.db.patch('memberships', owner.membershipId, { role: 'rep' }));
	await expect(t.action(api.csmBookings.availability, args)).rejects.toThrow();
	expect(fetcher).not.toHaveBeenCalled();
});
it('preserves replay/adoption ahead of new-booking eligibility and sender uses fresh explicit-duration preflight', async () => {
	const { t, owner, args } = await fixture();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string) => response(input.includes('event-types') ? event : times))
	);
	await t.action(api.csmBookings.availability, args);
	const attemptId = await t.run(async (ctx) =>
		ctx.db.insert('csmBookingAttempts', {
			companyId: owner.companyId,
			profileId: owner.profileId,
			membershipId: owner.membershipId,
			mode: 'setup',
			operationId: 'synthetic-operation',
			requestedStart: start,
			timeZone: 'UTC',
			attendeeName: 'Synthetic',
			attendeeEmail: identity.email,
			state: 'queued',
			revision: 0,
			updatedAt: +now
		})
	);
	for (const operationId of ['synthetic-operation', 'different-operation']) {
		expect(
			await t.mutation(api.csmBookings.book, {
				membershipId: owner.membershipId,
				mode: 'setup',
				start,
				timeZone: 'UTC',
				operationId,
				receiptProtocol: 'creation-v1'
			})
		).toEqual({ attemptId, operationId: 'synthetic-operation' });
	}
	const urls: URL[] = [],
		methods: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string, init: RequestInit) => {
			urls.push(new URL(input));
			methods.push(init.method!);
			return response(input.includes('event-types') ? event : times);
		})
	);
	// No active baseline: fresh preflight may read, but the live claim must refuse create POST.
	await t.action(internal.csmBookings.send, { attemptId });
	expect(urls.map((u) => u.pathname)).toEqual(['/v2/event-types/' + EVENT_ID, '/v2/slots']);
	expect(urls[1].searchParams.get('duration')).toBe('30');
	expect(methods).toEqual(['GET', 'GET']);
});

it('missing local credentials and deleted companies perform no provider work', async () => {
	const { t, owner, args } = await fixture();
	const fetcher = vi.fn();
	vi.stubGlobal('fetch', fetcher);
	vi.stubEnv('CAL_WEBHOOK_SECRET', '');
	expect((await t.action(api.csmBookings.availability, args)).status).toBe('unavailable');
	vi.stubEnv('CAL_WEBHOOK_SECRET', 'synthetic');
	await t.run(async (ctx) => {
		await ctx.db.insert('companyDeletions', {
			companyId: owner.companyId,
			issuer: identity.issuer,
			clerkId: identity.subject,
			attemptId: 'synthetic-deletion',
			requestedAt: +now,
			cleanupGeneration: 0,
			status: 'prepared',
			phase: 'invitations'
		});
	});
	await expect(t.action(api.csmBookings.availability, args)).rejects.toThrow();
	expect(fetcher).not.toHaveBeenCalled();
});
it('a sender rechecks revoked membership after fresh preflight and never dispatches a create POST', async () => {
	const { t, owner } = await fixture();
	const attemptId = await t.run(async (ctx) => {
		const baselineId = await ctx.db.insert('baselines', {
			companyId: owner.companyId,
			source: 'seed',
			state: 'active',
			bootstrapKey: 'synthetic',
			activatedAt: +now,
			fingerprint: 'synthetic',
			issues: [],
			blockCount: 0,
			chunkCount: 0,
			blocksJsonBytes: 2,
			chunkReadBytes: 0
		});
		await ctx.db.patch('company', owner.companyId, { baselineId });
		return ctx.db.insert('csmBookingAttempts', {
			companyId: owner.companyId,
			profileId: owner.profileId,
			membershipId: owner.membershipId,
			mode: 'setup',
			operationId: 'synthetic-revoked-operation',
			requestedStart: start,
			timeZone: 'UTC',
			attendeeName: 'Synthetic',
			attendeeEmail: identity.email,
			state: 'queued',
			revision: 0,
			updatedAt: +now
		});
	});
	const reached = deferred<void>(),
		slotRead = deferred<Response>();
	const fetcher = vi.fn((input: string) => {
		if (input.includes('event-types')) return Promise.resolve(response(event));
		reached.resolve();
		return slotRead.promise;
	});
	vi.stubGlobal('fetch', fetcher);
	const send = t.action(internal.csmBookings.send, { attemptId });
	await reached.promise;
	await t.run(async (ctx) => ctx.db.patch('memberships', owner.membershipId, { role: 'rep' }));
	slotRead.resolve(response(times));
	await send;
	expect(fetcher.mock.calls).toHaveLength(2);
	expect((await t.run((ctx) => ctx.db.get('csmBookingAttempts', attemptId)))?.state).toBe('failed');
});
