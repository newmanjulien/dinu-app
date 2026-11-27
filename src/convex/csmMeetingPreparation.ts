/** A confirmed call never depends on this independent, bounded preparation protocol. */
import { v } from 'convex/values';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import {
	internalAction,
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
	type ActionCtx
} from './_generated/server';
import schema from './schema';
import { availableCompany, liveProfile } from './auth';
import { cancelJob } from './emailDeliveries';
import { validOperator } from './csmAttemptState';
import { frozenAttemptReference } from './csmIdentity';
import {
	bookingInScope,
	calRead,
	calRequest,
	MEETING_PLACEHOLDER,
	object,
	parseSetupBooking,
	type ProviderBooking
} from './csmCal';
import { CalRateLimitError } from './csmProviderFailures';
import { providerBooking } from './csmBookingValidators';
import { meetingState } from './csmMeetingValidators';

type Preparation = Doc<'csmMeetingPreparations'>;
const key = { preparationId: v.id('csmMeetingPreparations') };
const claimed = { ...key, revision: v.number() };
const WINDOW = 15 * 60_000;
const LEASE = 150_000;
const MAX_PASSES = 8;
function hash(value: string) {
	return bytesToHex(sha256(new TextEncoder().encode(value)));
}
function emailHash(value: string) {
	return hash(value.trim().toLowerCase());
}

async function schedule(ctx: MutationCtx, p: Preparation, delay: number) {
	await cancelJob(ctx, p.jobId);
	const startAt = Date.now() + delay;
	const dueAt = startAt + LEASE;
	const jobId = await ctx.scheduler.runAt(startAt, internal.csmMeetingPreparation.prepare, {
		preparationId: p._id
	});
	await ctx.db.patch('csmMeetingPreparations', p._id, { jobId, dueAt });
	await ctx.scheduler.runAt(dueAt, internal.csmMeetingPreparation.wake, {
		preparationId: p._id,
		dueAt
	});
}
export async function cancelPreparationJobs(ctx: MutationCtx, p: Preparation) {
	await cancelJob(ctx, p.jobId);
	await cancelJob(ctx, p.watchdogId);
}
async function live(ctx: QueryCtx, p: Preparation, requireCurrent = true) {
	if (!(await availableCompany(ctx, p.companyId)) || !(await liveProfile(ctx, p.profileId)))
		return false;
	const a = await ctx.db.get('csmBookingAttempts', p.attemptId);
	if (
		!a ||
		a.state !== 'booked' ||
		a.meetingPolicy !== 'google-meet-after-booking' ||
		frozenAttemptReference(a) !== p.reference
	)
		return false;
	if (a.mode === 'setup') {
		const appointment = await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_attemptId', (q) => q.eq('attemptId', a._id))
			.unique();
		if (
			appointment?.superseded ||
			(requireCurrent && appointment?.status === 'cancelled' && appointment.currentUid === p.uid)
		)
			return false;
	}
	// Cal owns native reschedule identity; the setup projection can still be catching up.
	// Read old UIDs to prove successors, but never reserve a write for a past time.
	return !requireCurrent || Date.parse(p.start) > Date.now();
}
async function insert(
	ctx: MutationCtx,
	a: Doc<'csmBookingAttempts'>,
	b: ProviderBooking,
	attendeeHash: string
) {
	if (!a.providerScope || !frozenAttemptReference(a)) return;
	if (
		await ctx.db
			.query('csmMeetingPreparations')
			.withIndex('by_uid', (q) => q.eq('uid', b.uid))
			.unique()
	)
		return;
	const id = await ctx.db.insert('csmMeetingPreparations', {
		companyId: a.companyId,
		profileId: a.profileId,
		attemptId: a._id,
		uid: b.uid,
		start: b.start,
		end: b.end,
		scope: a.providerScope,
		reference: frozenAttemptReference(a)!,
		attendeeHash,
		state: 'pending',
		revision: 0,
		passes: 0,
		expiresAt: Date.now() + WINDOW,
		writeReserved: false,
		updatedAt: Date.now()
	});
	await schedule(ctx, (await ctx.db.get('csmMeetingPreparations', id))!, 0);
}
/** Called only inside the common accepted-booking settlement transaction. */
export async function seedMeetingPreparation(
	ctx: MutationCtx,
	a: Doc<'csmBookingAttempts'>,
	b: ProviderBooking,
	email: string
) {
	if (a.meetingPolicy === 'google-meet-after-booking' && b.status === 'accepted')
		await insert(ctx, a, b, emailHash(email));
}
export const inspect = internalQuery({
	args: key,
	returns: v.union(schema.doc('csmMeetingPreparations'), v.null()),
	handler: (ctx, { preparationId }) => ctx.db.get('csmMeetingPreparations', preparationId)
});
export const needsAttention = internalQuery({
	args: {},
	returns: v.array(schema.doc('csmMeetingPreparations')),
	handler: (ctx) =>
		ctx.db
			.query('csmMeetingPreparations')
			.withIndex('by_state', (q) => q.eq('state', 'needs-attention'))
			.take(50)
});
export const begin = internalMutation({
	args: key,
	returns: v.union(schema.doc('csmMeetingPreparations'), v.null()),
	handler: async (ctx, { preparationId }): Promise<Preparation | null> => {
		const p = await ctx.db.get('csmMeetingPreparations', preparationId);
		if (!p || !['pending', 'unknown'].includes(p.state)) return null;
		if (!(await live(ctx, p, false))) {
			await ctx.db.patch('csmMeetingPreparations', p._id, {
				state: 'stopped',
				reason: 'Booking is no longer current and upcoming.',
				revision: p.revision + 1
			});
			return null;
		}
		if (p.passes >= MAX_PASSES || Date.now() >= p.expiresAt) {
			await ctx.db.patch('csmMeetingPreparations', p._id, {
				state: 'needs-attention',
				reason:
					p.mode === 'successor-only'
						? 'Successor discovery budget exhausted; inspect the rescheduled booking.'
						: 'Preparation reconciliation budget exhausted.'
			});
			return null;
		}
		await cancelPreparationJobs(ctx, p);
		const revision = p.revision + 1;
		const leaseUntil = Date.now() + LEASE;
		const watchdogId = await ctx.scheduler.runAt(
			leaseUntil,
			internal.csmMeetingPreparation.expireClaim,
			{ preparationId, revision }
		);
		await ctx.db.patch('csmMeetingPreparations', p._id, {
			state: 'running',
			refreshRequested: undefined,
			revision,
			passes: p.passes + 1,
			leaseUntil,
			dueAt: leaseUntil,
			watchdogId,
			jobId: undefined,
			updatedAt: Date.now()
		});
		return ctx.db.get('csmMeetingPreparations', p._id);
	}
});
export const expireClaim = internalMutation({
	args: claimed,
	returns: v.null(),
	handler: async (ctx, { preparationId, revision }) => {
		const p = await ctx.db.get('csmMeetingPreparations', preparationId);
		if (!p || p.state !== 'running' || p.revision !== revision) return null;
		await ctx.db.patch('csmMeetingPreparations', p._id, {
			state: 'unknown',
			revision: p.revision + 1,
			leaseUntil: undefined,
			updatedAt: Date.now()
		});
		await schedule(ctx, p, 0);
		return null;
	}
});
export const reserveWrite = internalMutation({
	args: { ...claimed, calendarHash: v.string() },
	returns: v.boolean(),
	handler: async (ctx, { preparationId, revision, calendarHash }) => {
		const p = await ctx.db.get('csmMeetingPreparations', preparationId);
		if (
			!p ||
			p.state !== 'running' ||
			p.revision !== revision ||
			p.mode === 'successor-only' ||
			p.writeReserved ||
			(p.leaseUntil ?? 0) <= Date.now() ||
			!(await live(ctx, p))
		)
			return false;
		await ctx.db.patch('csmMeetingPreparations', p._id, {
			writeReserved: true,
			calendarHash,
			updatedAt: Date.now()
		});
		return true;
	}
});
export const finish = internalMutation({
	args: {
		...claimed,
		state: meetingState,
		reason: v.optional(v.string()),
		meetingUrl: v.optional(v.string()),
		predispatch: v.optional(v.boolean()),
		delay: v.optional(v.number())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const p = await ctx.db.get('csmMeetingPreparations', args.preparationId);
		if (!p || p.state !== 'running' || p.revision !== args.revision) return null;
		await cancelPreparationJobs(ctx, p);
		const current = await live(ctx, p, p.mode !== 'successor-only');
		const retry =
			current &&
			(args.state === 'unknown' || (args.state === 'ready' && p.refreshRequested === true)) &&
			p.passes < MAX_PASSES &&
			Date.now() < p.expiresAt;
		const state = !current
			? 'stopped'
			: args.state === 'unknown' && !retry
				? 'needs-attention'
				: retry
					? 'unknown'
					: args.state;
		await ctx.db.patch('csmMeetingPreparations', p._id, {
			state,
			reason: args.reason,
			meetingUrl: current ? args.meetingUrl : undefined,
			writeReserved: args.predispatch && p.mode !== 'successor-only' ? false : p.writeReserved,
			leaseUntil: undefined,
			watchdogId: undefined,
			dueAt: undefined,
			updatedAt: Date.now()
		});
		if (retry)
			await schedule(
				ctx,
				p,
				Math.max(1000, Math.min(args.delay ?? 5000 * 2 ** Math.min(p.passes - 1, 5), WINDOW))
			);
		return null;
	}
});
function calendarIdentity(data: Record<string, unknown>) {
	if (!Array.isArray(data.references)) return null;
	const refs = data.references.filter((r) => object(r) && r.type === 'google_calendar');
	if (
		refs.length !== 1 ||
		!object(refs[0]) ||
		typeof refs[0].eventUid !== 'string' ||
		!refs[0].eventUid ||
		refs[0].deleted === true
	)
		return null;
	const r = refs[0];
	const eventUid = r.eventUid;
	if (
		typeof eventUid !== 'string' ||
		typeof r.id !== 'number' ||
		!['string', 'number'].includes(typeof r.destinationCalendarId)
	)
		return null;
	return {
		hash: hash(JSON.stringify([r.id, r.eventUid, r.destinationCalendarId])),
		eventUid
	};
}
function observation(data: unknown, p: Preparation, uid = p.uid) {
	if (
		!object(data) ||
		!bookingInScope(data, p.scope) ||
		!object(data.metadata) ||
		data.metadata.dinuCsmAttempt !== p.reference ||
		!Array.isArray(data.attendees) ||
		!data.attendees.some(
			(a) => object(a) && typeof a.email === 'string' && emailHash(a.email) === p.attendeeHash
		)
	)
		return null;
	const booking = parseSetupBooking(data, uid, {
		companyId: p.companyId,
		profileId: p.profileId,
		providerScope: p.scope,
		attemptReference: p.reference
	});
	return booking
		? {
				booking,
				data,
				calendarHash: null as string | null,
				calendarEventUid: null as string | null
			}
		: null;
}
async function readObservation(ctx: ActionCtx, p: Preparation, uid = p.uid) {
	const seen = observation(
		await calRead(ctx, `bookings/${encodeURIComponent(uid)}`, '2026-02-25'),
		p,
		uid
	);
	if (!seen || seen.booking.status !== 'accepted' || seen.booking.toUid) return seen;
	const references = await calRead(
		ctx,
		`bookings/${encodeURIComponent(uid)}/references`,
		'2026-02-25'
	);
	const reference = calendarIdentity({ references });
	return {
		...seen,
		calendarHash: reference?.hash ?? null,
		calendarEventUid: reference?.eventUid ?? null
	};
}
async function calendarEvent(ctx: ActionCtx, p: Preparation, eventUid: string) {
	const event = await calRead(
		ctx,
		`calendars/google/event/${encodeURIComponent(eventUid)}`,
		'2026-02-25'
	);
	if (
		!object(event) ||
		event.id !== eventUid ||
		event.source !== 'google' ||
		event.status !== 'accepted' ||
		!object(event.start) ||
		!object(event.end) ||
		typeof event.start.time !== 'string' ||
		typeof event.end.time !== 'string' ||
		Date.parse(event.start.time) !== Date.parse(p.start) ||
		Date.parse(event.end.time) !== Date.parse(p.end) ||
		!Array.isArray(event.attendees) ||
		!event.attendees.some(
			(a) => object(a) && typeof a.email === 'string' && emailHash(a.email) === p.attendeeHash
		)
	)
		return null;
	return event;
}
const isMeetUrl = (value: string) =>
	/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(value);
type CalendarLocation =
	{ kind: 'empty' | 'placeholder' | 'different' } | { kind: 'ready'; url: string };
/** Normalize the provider projection conservatively; a video type alone proves nothing. */
function calendarLocations(locations: unknown): CalendarLocation {
	if (!Array.isArray(locations)) return { kind: 'different' };
	if (!locations.length) return { kind: 'empty' };
	if (
		locations.some(
			(entry) =>
				!object(entry) ||
				typeof entry.type !== 'string' ||
				typeof entry.url !== 'string' ||
				!entry.url ||
				(entry.label !== undefined && typeof entry.label !== 'string')
		)
	)
		return { kind: 'different' };
	const videos = locations.filter((entry) => entry.type === 'video');
	if (videos.length !== 1) return { kind: 'different' };
	const video = videos[0];
	if (
		locations.length === 1 &&
		video.url === MEETING_PLACEHOLDER &&
		(video.label === undefined || video.label === MEETING_PLACEHOLDER)
	)
		return { kind: 'placeholder' };
	if (
		!isMeetUrl(video.url) ||
		(video.label !== undefined &&
			video.label !== video.url &&
			video.label !== video.url.slice('https://'.length)) ||
		locations.some(
			(entry) =>
				entry !== video &&
				!(
					(entry.type === 'phone' && /^tel:\+?[0-9][0-9,;*# +().-]*$/.test(entry.url)) ||
					(entry.type === 'sip' && /^sip:[a-z0-9-]+@meet\.google\.com$/.test(entry.url)) ||
					(entry.type === 'more' &&
						/^https:\/\/tel\.meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\?|$)/.test(entry.url))
				)
		)
	)
		return { kind: 'different' };
	return { kind: 'ready', url: video.url };
}
function location(
	data: Record<string, unknown>
): { kind: 'ready'; url: string } | { kind: 'placeholder' | 'pending' | 'different' } {
	const values = [data.location, data.meetingUrl].filter(
		(x): x is string => typeof x === 'string' && !!x
	);
	if (!values.length) return { kind: 'pending' };
	if (values.every(isMeetUrl) && new Set(values).size === 1)
		return { kind: 'ready', url: values[0] };
	if (values.every((s) => s === MEETING_PLACEHOLDER)) return { kind: 'placeholder' };
	if (
		values.every((s) =>
			['integrations:google:meet', 'integrations:google-meet', 'google-meet'].includes(s)
		)
	)
		return { kind: 'pending' };
	return { kind: 'different' };
}
export const prepare = internalAction({
	args: key,
	returns: v.null(),
	handler: async (ctx, { preparationId }) => {
		const p: Preparation | null = await ctx.runMutation(internal.csmMeetingPreparation.begin, {
			preparationId
		});
		if (!p) return null;
		const claim = { preparationId, revision: p.revision };
		let reserved = false,
			dispatched = false;
		try {
			const seen = await readObservation(ctx, p);
			if (!seen) {
				await ctx.runMutation(internal.csmMeetingPreparation.finish, {
					...claim,
					state: 'needs-attention',
					reason: 'Booking association could not be verified.'
				});
				return null;
			}
			const b = seen.booking;
			if (b.toUid) {
				const next = await readObservation(ctx, p, b.toUid);
				if (
					next &&
					next.booking.fromUid === p.uid &&
					next.booking.status === 'accepted' &&
					Date.parse(next.booking.start) > Date.now()
				)
					await ctx.runMutation(internal.csmMeetingPreparation.successor, {
						...claim,
						booking: next.booking
					});
				else
					await ctx.runMutation(internal.csmMeetingPreparation.finish, {
						...claim,
						state: 'needs-attention',
						reason: 'Rescheduled booking requires verification.'
					});
				return null;
			}
			// A hint only opens GET discovery. It never restores write rights on this UID.
			if (p.mode === 'successor-only') {
				await ctx.runMutation(internal.csmMeetingPreparation.finish, {
					...claim,
					state: 'unknown',
					reason: 'Waiting for an authenticated reciprocal reschedule successor.'
				});
				return null;
			}
			if (
				b.status !== 'accepted' ||
				b.start !== p.start ||
				b.end !== p.end ||
				Date.parse(b.start) <= Date.now()
			) {
				await ctx.runMutation(internal.csmMeetingPreparation.finish, {
					...claim,
					state: 'stopped',
					reason: 'Booking was cancelled, moved, or has started.'
				});
				return null;
			}
			if (!seen.calendarHash || (p.calendarHash && seen.calendarHash !== p.calendarHash)) {
				await ctx.runMutation(internal.csmMeetingPreparation.finish, {
					...claim,
					state: 'needs-attention',
					reason: 'Expected Google Calendar event is missing or changed.'
				});
				return null;
			}
			let current = location(seen.data);
			if (current.kind === 'placeholder' && !p.writeReserved) {
				const calendar = seen.calendarEventUid
					? await calendarEvent(ctx, p, seen.calendarEventUid)
					: null;
				const actual = calendarLocations(calendar?.locations);
				if (!calendar || (actual.kind !== 'empty' && actual.kind !== 'placeholder')) {
					await ctx.runMutation(internal.csmMeetingPreparation.finish, {
						...claim,
						state: 'needs-attention',
						reason: 'Google Calendar location differs from the owned placeholder; preserved.'
					});
					return null;
				}
				reserved = await ctx.runMutation(internal.csmMeetingPreparation.reserveWrite, {
					...claim,
					calendarHash: seen.calendarHash
				});
				if (!reserved) {
					await ctx.runMutation(internal.csmMeetingPreparation.finish, {
						...claim,
						state: 'unknown',
						reason: 'Write admission changed.'
					});
					return null;
				}
				await calRequest(
					ctx,
					`bookings/${encodeURIComponent(p.uid)}/location`,
					'2024-08-13',
					'PATCH',
					{ location: { type: 'integration', integration: 'google-meet' }, notifyHosts: false },
					() => {
						dispatched = true;
					}
				);
				// The PATCH status/body alone is never completion evidence. Read the authoritative booking.
				const updated = await readObservation(ctx, p);
				if (!updated || updated.calendarHash !== seen.calendarHash)
					throw new Error('Unverified calendar update');
				if (
					updated.booking.toUid ||
					updated.booking.status !== 'accepted' ||
					updated.booking.start !== p.start ||
					updated.booking.end !== p.end
				) {
					await ctx.runMutation(internal.csmMeetingPreparation.finish, {
						...claim,
						state: 'unknown',
						reason: 'Booking changed during location update.'
					});
					return null;
				}
				current = location(updated.data);
			}
			if (current.kind === 'ready') {
				const calendar = seen.calendarEventUid
					? await calendarEvent(ctx, p, seen.calendarEventUid)
					: null;
				const actual = calendarLocations(calendar?.locations);
				const url = current.url;
				if (!calendar || actual.kind !== 'ready' || actual.url !== url) {
					await ctx.runMutation(internal.csmMeetingPreparation.finish, {
						...claim,
						state:
							actual.kind === 'different' || actual.kind === 'ready'
								? 'needs-attention'
								: 'unknown',
						reason:
							'Google Calendar does not show only the same Meet link and compatible dial-in entries.'
					});
					return null;
				}
			}
			await ctx.runMutation(internal.csmMeetingPreparation.finish, {
				...claim,
				state:
					current.kind === 'ready'
						? 'ready'
						: current.kind === 'different'
							? 'needs-attention'
							: 'unknown',
				...(current.kind === 'ready'
					? { meetingUrl: current.url }
					: {
							reason:
								current.kind === 'different'
									? 'Location is manual or uses a different provider; preserved.'
									: 'Waiting for a verified Google Meet link; no repeated PATCH.'
						})
			});
		} catch (error) {
			await ctx.runMutation(internal.csmMeetingPreparation.finish, {
				...claim,
				state: 'unknown',
				reason:
					dispatched || p.writeReserved
						? 'Location update is uncertain; reconciling by GET only.'
						: 'Provider read or predispatch admission failed.',
				...(reserved && !dispatched ? { predispatch: true } : {}),
				...(error instanceof CalRateLimitError ? { delay: error.retryAfter } : {})
			});
		}
		return null;
	}
});
/** Only a reciprocal, authenticated successor observation may seed another UID. */
export const successor = internalMutation({
	args: { ...claimed, booking: providerBooking },
	returns: v.null(),
	handler: async (ctx, { preparationId, revision, booking }) => {
		const p = await ctx.db.get('csmMeetingPreparations', preparationId);
		if (
			!p ||
			p.state !== 'running' ||
			p.revision !== revision ||
			(p.leaseUntil ?? 0) <= Date.now() ||
			booking.uid === p.uid ||
			booking.fromUid !== p.uid ||
			booking.status !== 'accepted' ||
			Date.parse(booking.start) <= Date.now() ||
			!(await live(ctx, p, false))
		)
			return null;
		const a = await ctx.db.get('csmBookingAttempts', p.attemptId);
		if (!a || a.state !== 'booked') return null;
		await cancelPreparationJobs(ctx, p);
		await ctx.db.patch('csmMeetingPreparations', p._id, {
			state: 'stopped',
			revision: p.revision + 1,
			reason: 'Rescheduled to a verified successor.',
			updatedAt: Date.now()
		});
		await insert(ctx, a, booking, p.attendeeHash);
		return null;
	}
});
/** Signed webhook hints only wake existing, server-associated work. Provider GET owns facts. */
export const hint = internalMutation({
	args: { uid: v.string(), previousUid: v.optional(v.string()), reference: v.optional(v.string()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		for (const uid of new Set([args.uid, ...(args.previousUid ? [args.previousUid] : [])])) {
			const p = await ctx.db
				.query('csmMeetingPreparations')
				.withIndex('by_uid', (q) => q.eq('uid', uid))
				.unique();
			if (!p || (args.reference && args.reference !== p.reference)) continue;
			const newSuccessorHint =
				args.previousUid === p.uid && args.uid !== p.uid && args.uid !== p.lastHintedSuccessorUid;
			if (newSuccessorHint) {
				if (!(await live(ctx, p, false))) continue;
				await cancelPreparationJobs(ctx, p);
				await ctx.db.patch('csmMeetingPreparations', p._id, {
					mode: 'successor-only',
					lastHintedSuccessorUid: args.uid,
					state: 'unknown',
					revision: p.revision + 1,
					passes: 0,
					expiresAt: Date.now() + WINDOW,
					leaseUntil: undefined,
					watchdogId: undefined,
					refreshRequested: undefined,
					reason: 'Discovering an authenticated native reschedule successor by GET only.',
					updatedAt: Date.now()
				});
				await schedule(ctx, p, 0);
				continue;
			}
			if (p.state === 'needs-attention' || p.state === 'stopped') continue;
			if (p.state === 'running') {
				await ctx.db.patch('csmMeetingPreparations', p._id, { refreshRequested: true });
				continue;
			}
			await ctx.db.patch('csmMeetingPreparations', p._id, {
				state: 'unknown',
				...(p.state === 'ready' ? { passes: 0, expiresAt: Date.now() + WINDOW } : {})
			});
			await schedule(ctx, p, 0);
		}
		return null;
	}
});
/** Internal API: requires operator credentials and explicit evidence before another write. */
export const repair = internalMutation({
	args: {
		...claimed,
		operator: v.string(),
		evidence: v.string(),
		reason: v.string(),
		previousWriteFinished: v.literal(true)
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const p = await ctx.db.get('csmMeetingPreparations', args.preparationId);
		if (
			!p ||
			p.revision !== args.revision ||
			p.state !== 'needs-attention' ||
			!validOperator(args) ||
			!(await live(ctx, p, p.mode !== 'successor-only'))
		)
			throw new Error(
				'Inspect the preparation and provide authoritative evidence that the prior write has finished.'
			);
		const { operator, evidence, reason } = args;
		await ctx.db.patch('csmMeetingPreparations', p._id, {
			state: 'pending',
			revision: p.revision + 1,
			passes: 0,
			expiresAt: Date.now() + WINDOW,
			writeReserved: p.mode === 'successor-only' ? p.writeReserved : false,
			repair: { operator, evidence, reason, at: Date.now() },
			updatedAt: Date.now()
		});
		await schedule(ctx, p, 0);
		return null;
	}
});

export const wake = internalMutation({
	args: { preparationId: v.id('csmMeetingPreparations'), dueAt: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const p = await ctx.db.get('csmMeetingPreparations', args.preparationId);
		if (p?.dueAt === args.dueAt && args.dueAt <= Date.now())
			await ctx.scheduler.runAfter(0, internal.csmMeetingPreparation.pump, {});
		return null;
	}
});

/** Bounded scheduler repair also covers an action failing before it can claim its row. */
export const pump = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const due = await ctx.db
			.query('csmMeetingPreparations')
			.withIndex('by_dueAt', (q) => q.gt('dueAt', 0).lte('dueAt', Date.now()))
			.take(25);
		for (const p of due) {
			if (p.state === 'running' && (p.leaseUntil ?? 0) <= Date.now()) {
				await ctx.db.patch('csmMeetingPreparations', p._id, {
					state: 'unknown',
					revision: p.revision + 1,
					leaseUntil: undefined
				});
				await schedule(ctx, p, 0);
			} else if (p.state === 'pending' || p.state === 'unknown') {
				await schedule(ctx, p, 0);
			} else await ctx.db.patch('csmMeetingPreparations', p._id, { dueAt: undefined });
		}
		return null;
	}
});
