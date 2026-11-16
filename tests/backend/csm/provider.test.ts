// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import rateLimiter from '@convex-dev/rate-limiter/test';
import { api, internal } from '../../../src/convex/_generated/api';
import schema from '../../../src/convex/schema';
import { newAttemptReference } from '../../../src/convex/csmIdentity';
import { MEETING_PLACEHOLDER } from '../../../src/convex/csmCal';
const EVENT_ID = 101;
const ORGANIZER_ID = 202;
import { identity, initializeViewer } from '../../support/contract-data';
const modules = import.meta.glob('../../../src/convex/**/*.*s');
const now = new Date('2026-11-06T12:00:00Z');
const start = '2026-11-07T12:00:00.000Z';
const event = {
	id: EVENT_ID,
	slug: 'synthetic-event-label',
	users: [{ id: ORGANIZER_ID, username: 'synthetic-organizer-label' }],
	lengthInMinutes: 30,
	price: 0,
	bookingFields: [],
	locations: [{ type: 'integration', integration: 'google-meet' }, { type: 'attendeeDefined' }]
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
		timeZone: 'UTC'
	};
	return { t, owner, args };
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	vi.stubEnv('CAL_API_KEY', 'synthetic');
	vi.stubEnv('CAL_WEBHOOK_SECRET', 'synthetic');
	vi.stubEnv('CAL_EVENT_TYPE_ID', String(EVENT_ID));
	vi.stubEnv('CAL_ORGANIZER_ID', String(ORGANIZER_ID));
	vi.stubEnv('CAL_METADATA_SIGNING_SECRET', 'synthetic-metadata-key');
	vi.stubEnv('CAL_LEGACY_METADATA_SECRET', 'synthetic-old-key');
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
it('allows admin setup and support before template upload; rep calls and foreign reads stay restricted', async () => {
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
			operationId: 'synthetic-operation'
		})
	).resolves.toMatchObject({ operationId: 'synthetic-operation' });
	fetcher.mockClear();
	expect((await t.action(api.csmBookings.availability, { ...args, mode: 'support' })).status).toBe(
		'ready'
	);
	expect(fetcher).toHaveBeenCalledTimes(2);
	fetcher.mockClear();
	await expect(
		t
			.withIdentity({ ...identity, tokenIdentifier: 'foreign' })
			.action(api.csmBookings.availability, args)
	).rejects.toThrow();
	await t.run(async (ctx) => ctx.db.patch('memberships', owner.membershipId, { role: 'rep' }));
	await expect(t.action(api.csmBookings.availability, args)).rejects.toThrow();
	expect(fetcher).not.toHaveBeenCalled();
	await expect(
		t.action(api.csmBookings.availability, { ...args, mode: 'support' })
	).rejects.toThrow('permission');
	expect(fetcher).not.toHaveBeenCalled();
});
it('preserves replay/adoption ahead of new-booking eligibility and sender uses fresh explicit-duration preflight', async () => {
	const { t, owner, args } = await fixture();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string) => response(input.includes('event-types') ? event : times))
	);
	await t.action(api.csmBookings.availability, args);
	const attemptId = await t.run(async (ctx) => {
		const id = await ctx.db.insert('csmBookingAttempts', {
			companyId: owner.companyId,
			profileId: owner.profileId,
			membershipId: owner.membershipId,
			mode: 'setup',
			format: 2,
			providerScope: { eventTypeId: EVENT_ID, organizerId: ORGANIZER_ID },
			dispatchId: '0123456789abcdef0123456789abcdef',
			operationId: 'synthetic-operation',
			requestedStart: start,
			timeZone: 'UTC',
			attendeeName: 'Synthetic',
			attendeeEmail: identity.email,
			state: 'queued',
			revision: 0,
			updatedAt: +now
		});
		await ctx.db.patch('csmBookingAttempts', id, {
			attemptReference: newAttemptReference((await ctx.db.get('csmBookingAttempts', id))!)
		});
		return id;
	});
	for (const operationId of ['synthetic-operation', 'different-operation']) {
		expect(
			await t.mutation(api.csmBookings.book, {
				membershipId: owner.membershipId,
				mode: 'setup',
				start,
				timeZone: 'UTC',
				operationId
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
			return response(
				init.method === 'POST'
					? {
							uid: 'synthetic-confirmed-setup',
							eventTypeId: EVENT_ID,
							hosts: [{ id: ORGANIZER_ID }],
							attendees: [{ email: identity.email }],
							start,
							end: '2026-11-07T12:30:00.000Z',
							updatedAt: now.toISOString(),
							status: 'accepted'
						}
					: input.includes('event-types')
						? event
						: times
			);
		})
	);
	// No active source is needed: fresh preflight precedes exactly one accepted creation POST.
	await t.action(internal.csmBookings.send, { attemptId });
	expect(urls.map((u) => u.pathname)).toEqual([
		'/v2/event-types/' + EVENT_ID,
		'/v2/slots',
		'/v2/bookings'
	]);
	expect(urls[1].searchParams.get('duration')).toBe('30');
	expect(methods).toEqual(['GET', 'GET', 'POST']);
	expect((await t.run((ctx) => ctx.db.get('csmBookingAttempts', attemptId)))?.state).toBe('booked');
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
		const id = await ctx.db.insert('csmBookingAttempts', {
			companyId: owner.companyId,
			profileId: owner.profileId,
			membershipId: owner.membershipId,
			mode: 'setup',
			format: 2,
			providerScope: { eventTypeId: EVENT_ID, organizerId: ORGANIZER_ID },
			dispatchId: 'fedcba9876543210fedcba9876543210',
			operationId: 'synthetic-revoked-operation',
			requestedStart: start,
			timeZone: 'UTC',
			attendeeName: 'Synthetic',
			attendeeEmail: identity.email,
			state: 'queued',
			revision: 0,
			updatedAt: +now
		});
		await ctx.db.patch('csmBookingAttempts', id, {
			attemptReference: newAttemptReference((await ctx.db.get('csmBookingAttempts', id))!)
		});
		return id;
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

const meetUrl = 'https://meet.google.com/abc-defg-hij';
async function meetingFixture(patch: (signal: AbortSignal) => Promise<Response>) {
	const { t, owner } = await fixture();
	let metadata: Record<string, string> = {};
	let calLocation = MEETING_PLACEHOLDER;
	let calendarLocation = MEETING_PLACEHOLDER;
	const fetcher = vi.fn(async (input: string, init: RequestInit) => {
		const path = new URL(input).pathname;
		if (path === `/v2/event-types/${EVENT_ID}`) return response(event);
		if (path === '/v2/slots') return response(times);
		if (init.method === 'PATCH') return patch(init.signal!);
		if (path.endsWith('/references'))
			return response([
				{
					id: 1,
					type: 'google_calendar',
					eventUid: 'synthetic-calendar-event',
					destinationCalendarId: 2
				}
			]);
		if (path === '/v2/calendars/google/event/synthetic-calendar-event')
			return response({
				id: 'synthetic-calendar-event',
				source: 'google',
				status: 'accepted',
				start: { time: start },
				end: { time: '2026-11-07T12:30:00.000Z' },
				attendees: [{ email: identity.email }],
				locations: [{ type: 'video', url: calendarLocation }]
			});
		if (path === '/v2/bookings' && init.method === 'POST')
			metadata = JSON.parse(init.body as string).metadata;
		else if (path !== '/v2/bookings/synthetic-split-booking')
			throw new Error(`Unexpected provider request: ${init.method} ${path}`);
		return response({
			uid: 'synthetic-split-booking',
			eventTypeId: EVENT_ID,
			hosts: [{ id: ORGANIZER_ID }],
			attendees: [{ email: identity.email }],
			start,
			end: '2026-11-07T12:30:00.000Z',
			updatedAt: now.toISOString(),
			status: 'accepted',
			metadata,
			location: calLocation
		});
	});
	vi.stubGlobal('fetch', fetcher);
	const { attemptId } = await t.mutation(api.csmBookings.book, {
		membershipId: owner.membershipId,
		mode: 'setup',
		start,
		timeZone: 'UTC',
		operationId: 'synthetic-split-operation'
	});
	await t.action(internal.csmBookings.send, { attemptId });
	const preparation = await t.run((ctx) => ctx.db.query('csmMeetingPreparations').unique());
	expect(preparation).toMatchObject({ attemptId, state: 'pending', writeReserved: false });
	const key = { preparationId: preparation!._id };
	return {
		fetcher,
		prepare: () => t.action(internal.csmMeetingPreparation.prepare, key),
		read: () => t.query(internal.csmMeetingPreparation.inspect, key),
		attempt: () => t.run((ctx) => ctx.db.get('csmBookingAttempts', attemptId)),
		publish: (calendarReady: boolean) => {
			calLocation = meetUrl;
			if (calendarReady) calendarLocation = meetUrl;
		}
	};
}

it('confirms a placeholder booking before preparing Meet and requires matching Calendar evidence', async () => {
	const patchReached = deferred<void>(),
		patchResult = deferred<Response>();
	const f = await meetingFixture(() => {
		patchReached.resolve();
		return patchResult.promise;
	});
	expect(await f.attempt()).toMatchObject({
		state: 'booked',
		meetingPolicy: 'google-meet-after-booking'
	});
	const create = f.fetcher.mock.calls.find(([, init]) => init.method === 'POST')!;
	expect(JSON.parse(create[1].body as string).location).toEqual({
		type: 'attendeeDefined',
		location: MEETING_PLACEHOLDER
	});
	expect(f.fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
	const preparing = f.prepare();
	await patchReached.promise;
	expect(await f.attempt()).toMatchObject({ state: 'booked' });
	f.publish(false);
	patchResult.resolve(response({ meetingUrl: meetUrl }));
	await preparing;
	expect(await f.read()).toMatchObject({ state: 'unknown', writeReserved: true });
	expect((await f.read())?.meetingUrl).toBeUndefined();
	f.publish(true);
	vi.setSystemTime(+now + 5_000); // First scheduled reconciliation delay.
	await f.prepare();
	expect(await f.read()).toMatchObject({ state: 'ready', meetingUrl: meetUrl });
	const patches = f.fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH');
	expect(patches).toHaveLength(1);
	expect(JSON.parse(patches[0][1].body as string)).toEqual({
		location: { type: 'integration', integration: 'google-meet' },
		notifyHosts: false
	});
});

it('reconciles a timed-out Meet update by GET without dispatching another PATCH', async () => {
	const patchReached = deferred<void>();
	const f = await meetingFixture(
		(signal) =>
			new Promise<Response>((_resolve, reject) => {
				signal.addEventListener(
					'abort',
					() => reject(new DOMException('Timed out', 'AbortError')),
					{ once: true }
				);
				patchReached.resolve();
			})
	);
	const preparing = f.prepare();
	await patchReached.promise;
	await vi.advanceTimersByTimeAsync(20_000);
	await preparing;
	expect(await f.read()).toMatchObject({ state: 'unknown', writeReserved: true });
	expect(await f.attempt()).toMatchObject({ state: 'booked' });
	const afterTimeout = f.fetcher.mock.calls.length;
	vi.setSystemTime(+now + 25_000);
	await f.prepare(); // Cal still shows the placeholder after the ambiguous write.
	expect(await f.read()).toMatchObject({ state: 'unknown', writeReserved: true });
	f.publish(true); // The original update eventually becomes visible.
	vi.setSystemTime(+now + 35_000);
	await f.prepare();
	expect(await f.read()).toMatchObject({ state: 'ready', meetingUrl: meetUrl });
	expect(f.fetcher.mock.calls.slice(afterTimeout).every(([, init]) => init.method === 'GET')).toBe(
		true
	);
	expect(f.fetcher.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1);
});
