/** Cal's organizer credential and responses stay entirely on the backend. */
import { env, type ActionCtx } from './_generated/server';
import { RateLimiter } from '@convex-dev/rate-limiter';
import { components } from './_generated/api';
import type { Infer } from 'convex/values';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { bookingMode, providerBooking } from './csmBookingValidators';
import { readTextBody } from './uploadHttp';

export const EVENT_ID = 2928313;
export const HOST = 'juliennewman';
export const EVENT_SLUG = 'julien';
export type BookingMode = Infer<typeof bookingMode>;
export type ProviderBooking = Infer<typeof providerBooking>;
const encoder = new TextEncoder();
const limiter = new RateLimiter(components.rateLimiter, {
	provider: { kind: 'token bucket', rate: 80, period: 60_000, capacity: 12 }
});
export function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function iso(value: unknown): string | null {
	return typeof value === 'string' && Number.isFinite(Date.parse(value))
		? new Date(value).toISOString()
		: null;
}
/** Current-state authority requires a complete, real instant with millisecond precision. */
function setupInstant(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
			value
		);
	if (!match) return null;
	const [, y, m, d, h, min, s, fraction, zone] = match;
	const year = Number(y),
		month = Number(m),
		day = Number(d);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > days[month - 1] ||
		Number(h) > 23 ||
		Number(min) > 59 ||
		Number(s) > 59 ||
		zone === '-00:00'
	)
		return null;
	const offsetHours = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
	const offsetMinutes = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
	if (offsetHours > 23 || offsetMinutes > 59) return null;
	// setUTCFullYear avoids Date.UTC's special interpretation of years 00–99.
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(Number(h), Number(min), Number(s), Number((fraction ?? '').padEnd(3, '0')));
	const offset = (offsetHours * 60 + offsetMinutes) * 60_000 * (zone[0] === '-' ? -1 : 1);
	const instant = new Date(date.getTime() - offset);
	if (
		!Number.isFinite(instant.getTime()) ||
		instant.getUTCFullYear() < 0 ||
		instant.getUTCFullYear() > 9999
	)
		return null;
	return instant.toISOString();
}
export function validTimeZone(zone: string) {
	try {
		new Intl.DateTimeFormat('en', { timeZone: zone }).format();
		return zone.length <= 100;
	} catch {
		return false;
	}
}
export function dateInZone(timeZone: string) {
	const formatter = new Intl.DateTimeFormat('en', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
	return (start: string) => {
		const parts = formatter.formatToParts(new Date(start));
		return ['year', 'month', 'day']
			.map((type) => parts.find((p) => p.type === type)!.value)
			.join('-');
	};
}
export function referenceMessage(companyId: string, mode: BookingMode) {
	return `csm-booking:v2:${env.CONVEX_CLOUD_URL}:${mode}:${companyId}`;
}
export function signature(message: string) {
	if (!env.CAL_WEBHOOK_SECRET) throw new Error('Booking is unavailable.');
	return bytesToHex(hmac(sha256, encoder.encode(env.CAL_WEBHOOK_SECRET), encoder.encode(message)));
}
export function companyReference(companyId: string, mode: BookingMode) {
	return `${companyId}.${mode}.${signature(referenceMessage(companyId, mode))}`;
}
/** New compatibility links bind the original source; already issued v2 links remain readable. */
export function sourceMessage(companyId: string, mode: BookingMode, profileId: string) {
	return `csm-source:v1:${env.CONVEX_CLOUD_URL}:${mode}:${companyId}:${profileId}`;
}
export function sourceReference(companyId: string, mode: BookingMode, profileId: string) {
	return `${companyId}.${mode}.${profileId}.${signature(sourceMessage(companyId, mode, profileId))}`;
}
export async function parseCompanyReference(reference: string) {
	const parts = reference.split('.');
	if (
		!env.CAL_WEBHOOK_SECRET ||
		(parts.length !== 3 && parts.length !== 4) ||
		(parts[1] !== 'setup' && parts[1] !== 'support')
	)
		return null;
	const [companyId, mode] = parts as [string, BookingMode];
	const profileId = parts.length === 4 ? parts[2] : undefined;
	const message = profileId
		? sourceMessage(companyId, mode, profileId)
		: referenceMessage(companyId, mode);
	return (await verifySignature(env.CAL_WEBHOOK_SECRET, message, parts.at(-1)!))
		? { companyId, mode, profileId }
		: null;
}
export function attemptMessage(a: {
	_id: string;
	companyId: string;
	mode: BookingMode;
	requestedStart: string;
}) {
	return `csm-attempt:v1:${env.CONVEX_CLOUD_URL}:${a.companyId}:${a.mode}:${a.requestedStart}:${a._id}`;
}
export function attemptReference(a: Parameters<typeof attemptMessage>[0]) {
	return `${a._id}.${signature(attemptMessage(a))}`;
}
export async function verifySignature(secret: string, message: string, value: string) {
	if (!/^[a-f\d]{64}$/i.test(value)) return false;
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify']
	);
	return crypto.subtle.verify('HMAC', key, hexToBytes(value), encoder.encode(message));
}
export class CalReadError extends Error {}
export class CalRateLimitError extends CalReadError {
	constructor(readonly retryAfter: number) {
		super('The calendar is busy. Try again shortly.');
	}
}
/** No provider body, URL, attendee or credential is included in thrown errors/logs. */
export async function calRequest(
	ctx: ActionCtx,
	path: string,
	version: string,
	body?: unknown,
	onDispatch?: () => void
) {
	if (!env.CAL_API_KEY) throw new CalReadError('Booking is unavailable.');
	// Serialize before admission/dispatch: a local failure cannot be mistaken for a sent POST.
	const serialized = body === undefined ? undefined : JSON.stringify(body);
	const url = `https://api.cal.com/v2/${path}`;
	const headers = {
		Authorization: `Bearer ${env.CAL_API_KEY}`,
		'cal-api-version': version,
		'User-Agent': 'Dinu/1.0',
		...(body === undefined ? {} : { 'Content-Type': 'application/json' })
	};
	const admission = await limiter.limit(ctx, 'provider');
	if (!admission.ok) {
		if (!Number.isFinite(admission.retryAfter) || admission.retryAfter < 0)
			throw new CalReadError('Booking is unavailable.');
		throw new CalRateLimitError(admission.retryAfter);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), body === undefined ? 12_000 : 20_000);
	try {
		onDispatch?.();
		const response = await fetch(url, {
			method: body === undefined ? 'GET' : 'POST',
			headers,
			...(serialized === undefined ? {} : { body: serialized }),
			signal: controller.signal,
			redirect: 'error'
		});
		const reader = response.body?.getReader();
		const text = reader ? await readTextBody(reader, 2 * 1024 * 1024) : null;
		if (text === null) throw new CalReadError('Invalid calendar response.');
		const result: unknown = JSON.parse(text);
		return { ok: response.ok, status: response.status, body: result };
	} catch {
		throw new CalReadError('The calendar request could not be completed.');
	} finally {
		clearTimeout(timer);
	}
}
export async function calRead(ctx: ActionCtx, path: string, version: string): Promise<unknown> {
	const response = await calRequest(ctx, path, version);
	if (!response.ok || !object(response.body) || response.body.status !== 'success')
		throw new CalReadError('The calendar could not be loaded.');
	return response.body.data;
}
export async function configuration(ctx: ActionCtx) {
	if (!env.CAL_WEBHOOK_SECRET || !env.CAL_API_KEY) return null;
	const event = await calRead(ctx, `event-types/${EVENT_ID}`, '2026-06-12');
	if (
		!object(event) ||
		event.id !== EVENT_ID ||
		event.slug !== EVENT_SLUG ||
		!Array.isArray(event.users) ||
		!event.users.some((u) => object(u) && u.username === HOST) ||
		typeof event.lengthInMinutes !== 'number' ||
		event.lengthInMinutes <= 0 ||
		typeof event.price !== 'number' ||
		event.price !== 0 ||
		event.requiresBookerEmailVerification === true ||
		event.bookingRequiresAuthentication === true ||
		event.isInstantEvent === true ||
		(object(event.recurrence) && event.recurrence.disabled !== true) ||
		(object(event.confirmationPolicy) && event.confirmationPolicy.disabled !== true) ||
		(object(event.seats) && event.seats.disabled !== true) ||
		!Array.isArray(event.bookingFields) ||
		event.bookingFields.some(
			(f) =>
				!object(f) ||
				(f.required === true &&
					!['name', 'email', 'location'].includes(String(f.field)) &&
					!(f.field === 'title' && f.hidden === true))
		) ||
		!Array.isArray(event.locations) ||
		event.locations.length !== 1
	)
		return null;
	const location = event.locations[0];
	if (
		!object(location) ||
		location.type !== 'integration' ||
		!['google-meet', 'zoom', 'cal-video', 'daily'].includes(String(location.integration))
	)
		return null;
	// Only derive a UI navigation bound for a known calendar-day window. Cal remains authoritative.
	const window = event.bookingWindow;
	const lastDate =
		object(window) && window.type === 'calendarDays' && typeof window.value === 'number'
			? new Date(Date.now() + (window.value + 1) * 86_400_000).toISOString().slice(0, 10)
			: null;
	return {
		duration: event.lengthInMinutes,
		lastDate,
		location: { type: 'integration', integration: String(location.integration) }
	};
}
export async function slots(
	ctx: ActionCtx,
	start: string,
	end: string,
	timeZone: string,
	duration?: number
) {
	const q = new URLSearchParams({
		eventTypeId: String(EVENT_ID),
		start,
		end,
		timeZone,
		...(duration === undefined ? {} : { duration: String(duration) }),
		format: 'range'
	});
	const data = await calRead(ctx, `slots?${q}`, '2024-09-04');
	if (!object(data)) throw new CalReadError('Invalid calendar response.');
	const result: { start: string; end: string }[] = [];
	for (const day of Object.values(data)) {
		if (!Array.isArray(day)) throw new CalReadError('Invalid calendar response.');
		for (const slot of day) {
			if (!object(slot)) throw new CalReadError('Invalid calendar response.');
			const a = iso(slot.start),
				b = iso(slot.end);
			if (!a || !b || b <= a) throw new CalReadError('Invalid calendar response.');
			if (Date.parse(a) > Date.now()) result.push({ start: a, end: b });
			if (result.length > 6000) throw new CalReadError('Calendar response is too large.');
		}
	}
	return [...new Map(result.map((s) => [s.start, s])).values()].sort((a, b) =>
		a.start.localeCompare(b.start)
	);
}
/** Validate scope on every API result, including explicitly linked reschedule successors. */
export function parseBooking(data: unknown, attendeeEmail: string): ProviderBooking | null {
	if (
		!object(data) ||
		!validBookingUid(data.uid) ||
		data.eventTypeId !== EVENT_ID ||
		!Array.isArray(data.attendees) ||
		!data.attendees.some(
			(a) =>
				object(a) &&
				typeof a.email === 'string' &&
				a.email.toLowerCase() === attendeeEmail.toLowerCase()
		)
	)
		return null;
	const start = iso(data.start),
		end = iso(data.end),
		updatedAt = iso(data.updatedAt);
	const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';
	if (
		!start ||
		!end ||
		end <= start ||
		!updatedAt ||
		!['accepted', 'pending', 'cancelled', 'rejected'].includes(status)
	)
		return null;
	const link = (v: unknown) =>
		v === undefined || v === null || v === ''
			? undefined
			: typeof v === 'string' && v.length <= 200
				? v
				: null;
	const fromUid = link(data.rescheduledFromUid),
		toUid = link(data.rescheduledToUid);
	if (fromUid === null || toUid === null) return null;
	return {
		uid: data.uid,
		start,
		end,
		status: status as ProviderBooking['status'],
		fromUid,
		toUid,
		updatedAt: Date.parse(updatedAt)
	};
}

/** An immutable, previously proven UID replaces attendee-email retention for appointment reads. */
export function parseSetupBooking(
	data: unknown,
	uid: string,
	scope?: { companyId: string; profileId: string; attemptReference?: string }
): ProviderBooking | null {
	if (
		!object(data) ||
		data.uid !== uid ||
		!validBookingUid(uid) ||
		data.eventTypeId !== EVENT_ID ||
		!Array.isArray(data.hosts) ||
		!data.hosts.some((h) => object(h) && h.username === HOST) ||
		(object(data.eventType) && data.eventType.slug !== EVENT_SLUG)
	)
		return null;
	if (data.metadata !== undefined && data.metadata !== null && !object(data.metadata)) return null;
	const metadata = object(data.metadata) ? data.metadata : {};
	if (scope) {
		if (
			metadata.dinuCsmAttempt !== undefined &&
			(!scope.attemptReference || metadata.dinuCsmAttempt !== scope.attemptReference)
		)
			return null;
		if (
			metadata.dinuCsmReference !== undefined &&
			metadata.dinuCsmReference !== companyReference(scope.companyId, 'setup') &&
			metadata.dinuCsmReference !== sourceReference(scope.companyId, 'setup', scope.profileId)
		)
			return null;
	}
	const start = setupInstant(data.start),
		end = setupInstant(data.end),
		updatedAt = setupInstant(data.updatedAt);
	const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';
	const link = (value: unknown) =>
		value === undefined || value === null || value === ''
			? undefined
			: validBookingUid(value)
				? value
				: null;
	const fromUid = link(data.rescheduledFromUid),
		toUid = link(data.rescheduledToUid);
	if (
		!start ||
		!end ||
		end <= start ||
		!updatedAt ||
		fromUid === null ||
		toUid === null ||
		!['accepted', 'pending', 'cancelled', 'rejected'].includes(status)
	)
		return null;
	return {
		uid,
		start,
		end,
		updatedAt: Date.parse(updatedAt),
		status: status as ProviderBooking['status'],
		fromUid,
		toUid
	};
}
export function validBookingUid(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/** Only known pre-creation rejections may release an already dispatched request.
 * Cal's ErrorsBookingsService_2024_08_13 maps these guards to HTTP 400 before creation.
 * Unrecognized errors, including all 5xx responses, remain uncertain.
 */
export function noncreatingRejection(status: number, body: unknown): 'conflict' | 'limit' | null {
	if (
		status !== 400 ||
		!object(body) ||
		!object(body.error) ||
		typeof body.error.message !== 'string'
	)
		return null;
	const message = body.error.message;
	if (
		message === 'User either already has booking at this time or is not available' ||
		message === 'One of the hosts either already has booking at this time or is not available' ||
		message === 'Attempting to book a meeting in the past.'
	)
		return 'conflict';
	if (
		/^Attendee with this email can't book because the maximum number of active bookings has been reached\.( You can reschedule your existing booking \([a-zA-Z0-9_-]+\) to a new timeslot instead\.)?$/.test(
			message
		)
	)
		return 'limit';
	return null;
}
