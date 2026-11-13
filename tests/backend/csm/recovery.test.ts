// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import rateLimiter from '@convex-dev/rate-limiter/test';
import { api, internal } from '../../../src/convex/_generated/api';
import schema from '../../../src/convex/schema';
import { identity, initializeViewer } from '../../support/contract-data';

const modules = import.meta.glob('../../../src/convex/**/*.*s');
const now = Date.parse('2026-11-06T12:00:00Z');
const start = '2026-11-07T12:00:00.000Z';
const end = '2026-11-07T12:30:00.000Z';
const scope = { eventTypeId: 101, organizerId: 202 };
const uid = 'synthetic-recovery-booking';
const event = {
	id: scope.eventTypeId,
	slug: 'synthetic-event',
	users: [{ id: scope.organizerId, username: 'synthetic-organizer' }],
	lengthInMinutes: 30,
	price: 0,
	bookingFields: [],
	locations: [{ type: 'integration', integration: 'google-meet' }]
};
const response = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }));
const listing = (data: unknown[]) =>
	new Response(JSON.stringify({ status: 'success', data, pagination: { hasMore: false } }));
function booking(reference: string, status: 'accepted' | 'cancelled') {
	return {
		uid,
		eventTypeId: scope.eventTypeId,
		hosts: [{ id: scope.organizerId }],
		attendees: [{ email: identity.email }],
		start,
		end,
		updatedAt: new Date(now).toISOString(),
		status,
		metadata: { dinuCsmAttempt: reference }
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => (resolve = yes));
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
		start,
		timeZone: 'UTC',
		operationId: 'synthetic-recovery-operation'
	};
	return { t, owner, args };
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	vi.stubEnv('CAL_API_KEY', 'synthetic');
	vi.stubEnv('CAL_WEBHOOK_SECRET', 'synthetic-webhook-key');
	vi.stubEnv('CAL_EVENT_TYPE_ID', String(scope.eventTypeId));
	vi.stubEnv('CAL_ORGANIZER_ID', String(scope.organizerId));
	vi.stubEnv('CAL_METADATA_SIGNING_SECRET', 'synthetic-metadata-key');
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

it('recovers an ambiguous create by GET only and never treats a canceled sender as failure proof', async () => {
	const { t, args } = await fixture();
	const ack = await t.mutation(api.csmBookings.book, args);
	let recovered: unknown[] = [];
	const fetcher = vi.fn(async (input: string, init: RequestInit) => {
		const path = new URL(input).pathname;
		if (path === '/v2/event-types/101') return response(event);
		if (path === '/v2/slots') return response({ '2026-11-07': [{ start, end }] });
		if (path !== '/v2/bookings') throw new Error(`Unexpected request: ${path}`);
		if (init.method === 'POST') throw new TypeError('Response lost after dispatch');
		return listing(recovered);
	});
	vi.stubGlobal('fetch', fetcher);
	await t.action(internal.csmBookings.send, { attemptId: ack.attemptId });
	const read = () => t.run((ctx) => ctx.db.get('csmBookingAttempts', ack.attemptId));
	expect(await read()).toMatchObject({ state: 'unknown', error: 'uncertain' });
	await t.run(async (ctx) => {
		const a = (await ctx.db.get('csmBookingAttempts', ack.attemptId))!;
		await ctx.scheduler.cancel(a.sendJobId!);
	});
	const afterDispatch = fetcher.mock.calls.length;
	await t.action(internal.csmBookings.recoverAttempt, { attemptId: ack.attemptId });
	const empty = (await read())!;
	expect(empty).toMatchObject({ state: 'unknown', recoveryFailures: 1 });
	expect(empty.senderTerminal).toBeUndefined();
	// Even a signed provider cancellation cannot release a sender that may still be running.
	recovered = [booking(empty.attemptReference!, 'cancelled')];
	vi.setSystemTime(empty.recoveryDue!);
	await t.action(internal.csmBookings.recoverAttempt, { attemptId: ack.attemptId });
	expect(await read()).toMatchObject({ state: 'unknown', error: 'uncertain', providerUid: uid });
	expect((await read())?.failureBasis).toBeUndefined();
	expect(
		await t.mutation(api.csmBookings.book, { ...args, operationId: 'synthetic-second-operation' })
	).toEqual(ack);
	await t.action(internal.csmBookings.send, { attemptId: ack.attemptId });
	expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
	expect(fetcher.mock.calls.slice(afterDispatch).map(([, init]) => init.method)).toEqual([
		'GET',
		'GET'
	]);
	expect(await t.run((ctx) => ctx.db.query('csmBookingAttempts').take(2))).toHaveLength(1);
});

it('deduplicates webhook evidence and fences a stale recovery before publishing the newer result', async () => {
	const { t, args } = await fixture();
	const { attemptId } = await t.mutation(api.csmBookings.book, args);
	// Seed unresolved creation after a genuinely completed sender, before webhook recovery.
	await t.run((ctx) =>
		ctx.db.patch('csmBookingAttempts', attemptId, {
			state: 'unknown',
			error: 'uncertain',
			senderTerminal: { kind: 'success', observedAt: now }
		})
	);
	const reference = (await t.run((ctx) => ctx.db.get('csmBookingAttempts', attemptId)))!
		.attemptReference!;
	const hint = { uid, scope, reference, event: 'BOOKING_CREATED' as const, revision: '1' };
	await t.mutation(internal.csmEvidence.ingress, hint);
	const reached = deferred<void>();
	const staleResponse = deferred<Response>();
	const fetcher = vi.fn((_input: string, _init: RequestInit) => {
		reached.resolve();
		return staleResponse.promise;
	});
	vi.stubGlobal('fetch', fetcher);
	const recovering = t.action(internal.csmBookings.recoverAttempt, { attemptId });
	await reached.promise;
	const snapshot = () =>
		t.run(async (ctx) => ({
			attempt: await ctx.db.get('csmBookingAttempts', attemptId),
			evidence: await ctx.db.query('csmWebhookEvidence').take(3),
			jobs: await ctx.db.system.query('_scheduled_functions').take(20)
		}));
	const beforeDuplicate = await snapshot();
	expect(await t.mutation(internal.csmEvidence.ingress, hint)).toEqual({ kind: 'duplicate' });
	expect(await snapshot()).toEqual(beforeDuplicate);
	await t.mutation(internal.csmEvidence.ingress, {
		...hint,
		event: 'BOOKING_CANCELLED',
		revision: '2'
	});
	staleResponse.resolve(response(booking(reference, 'accepted')));
	await recovering;
	const stale = await snapshot();
	expect(stale.attempt).toMatchObject({
		state: 'unknown',
		recoveryGeneration: 2,
		recoveryFailures: 0
	});
	expect(stale.attempt?.confirmation).toBeUndefined();
	expect(stale.evidence.map((row) => row.state)).toEqual(['retained', 'retained']);
	vi.setSystemTime(stale.attempt!.recoveryDue!);
	fetcher.mockImplementation(async () => response(booking(reference, 'cancelled')));
	await t.action(internal.csmBookings.recoverAttempt, { attemptId });
	const latest = await snapshot();
	expect(latest.attempt).toMatchObject({
		state: 'failed',
		failureBasis: 'providerTerminal',
		providerUid: uid,
		recoveryFailures: 0
	});
	expect(latest.evidence.map((row) => row.state)).toEqual(['completed', 'completed']);
	expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'GET']);
});

it('blocks retry for unsafe historical failures and preserves their guards through account cleanup', async () => {
	const { t, owner, args } = await fixture();
	const fetcher = vi.fn(() => {
		throw new Error('Historical admission and erasure must not contact Cal');
	});
	vi.stubGlobal('fetch', fetcher);
	const { initialId, replacementId, replacement, markerId } = await t.run(async (ctx) => {
		const profileId = await ctx.db.insert('profiles', {
			identity: 'synthetic-departing-user',
			issuer: identity.issuer,
			clerkId: 'departing-user',
			email: 'departing@example.com',
			name: 'Departing admin',
			helpPreferences: { rep: false, buyer: false }
		});
		const membershipId = await ctx.db.insert('memberships', {
			companyId: owner.companyId,
			profileId,
			role: 'admin'
		});
		const appointmentId = await ctx.db.insert('csmSetupAppointments', {
			companyId: owner.companyId,
			profileId: owner.profileId,
			membershipId: owner.membershipId,
			source: 'native',
			providerScope: scope,
			anchorUid: uid,
			currentUid: uid,
			start,
			end,
			status: 'cancelled',
			confirmedBooking: { uid, start, end, status: 'cancelled', confirmedAt: now },
			selection: 'cancelled',
			sortAt: now,
			generation: 0,
			lease: 0,
			dirty: false,
			failures: 0
		});
		const fields = {
			companyId: owner.companyId,
			profileId,
			membershipId,
			mode: 'setup' as const,
			format: 2 as const,
			providerScope: scope,
			requestedStart: start,
			timeZone: 'UTC',
			state: 'failed' as const,
			error: 'cancelled' as const,
			failureBasis: 'providerTerminal' as const,
			providerUid: 'synthetic-historical-negative',
			senderTerminal: { kind: 'canceled', observedAt: now },
			revision: 0,
			updatedAt: now
		};
		const initialId = await ctx.db.insert('csmBookingAttempts', {
			...fields,
			operationId: 'synthetic-old-initial'
		});
		const replacement = { appointmentId, currentUid: uid };
		const replacementId = await ctx.db.insert('csmBookingAttempts', {
			...fields,
			replacement,
			operationId: 'synthetic-old-replacement'
		});
		// A real terminal token is a control: erasure should not block every failed receipt.
		await ctx.db.insert('csmBookingAttempts', {
			...fields,
			operationId: 'synthetic-safe-failure',
			senderTerminal: { kind: 'success', observedAt: now }
		});
		await ctx.db.patch('csmSetupAppointments', appointmentId, {
			replacementAttemptId: replacementId
		});
		await ctx.db.patch('company', owner.companyId, { setupAppointmentId: appointmentId });
		const markerId = await ctx.db.insert('deletedUsers', {
			issuer: identity.issuer,
			clerkId: 'departing-user',
			profileId,
			deletedAt: now,
			cleanupGeneration: 0,
			successorCursor: null,
			legacyActivityPhase: 'done',
			complete: false
		});
		return { initialId, replacementId, replacement, markerId };
	});
	const progress = () =>
		t.query(api.csmBookings.setupStatus, { membershipId: owner.membershipId, replacement });
	expect(await progress()).toEqual({ state: 'uncertain' });
	await expect(t.mutation(api.csmBookings.book, { ...args, replacement })).rejects.toThrow(
		'being updated'
	);
	await t.mutation(internal.accountDeletion.clean, { markerId, generation: 0 });
	expect(await t.run((ctx) => ctx.db.get('csmBookingAttempts', initialId))).toBeNull();
	expect(await t.run((ctx) => ctx.db.get('csmBookingAttempts', replacementId))).toBeNull();
	expect(
		await t.run((ctx) => ctx.db.get('csmSetupAppointments', replacement.appointmentId))
	).toMatchObject({ erasedReplacementUncertain: true });
	expect(await progress()).toEqual({ state: 'uncertain' });
	await expect(t.mutation(api.csmBookings.book, { ...args, replacement })).rejects.toThrow(
		'being updated'
	);
	const guards = await t.query(internal.csmErasureGuards.inspect, {
		companyId: owner.companyId,
		blocking: true,
		cursor: null
	});
	expect(guards.isDone).toBe(true);
	expect(guards.page).toHaveLength(1);
	expect(guards.page[0]).toMatchObject({ disposition: 'unresolved', phase: 'legacyUncertain' });
	expect(guards.page[0].terminal).toBeUndefined();
	// With no current appointment, the surviving initial guard still blocks a new creation.
	await t.run((ctx) => ctx.db.patch('company', owner.companyId, { setupAppointmentId: undefined }));
	expect(await t.query(api.csmBookings.setupStatus, { membershipId: owner.membershipId })).toEqual({
		state: 'uncertain'
	});
	await expect(t.mutation(api.csmBookings.book, args)).rejects.toThrow('still being confirmed');
	expect(fetcher).not.toHaveBeenCalled();
});
