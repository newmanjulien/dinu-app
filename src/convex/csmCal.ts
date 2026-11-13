/** Cal's organizer credential and responses stay entirely on the backend. */
import { env, type ActionCtx } from './_generated/server';
import { RateLimiter } from '@convex-dev/rate-limiter';
import { components } from './_generated/api';
import type { Infer } from 'convex/values';
import type { bookingMode, providerBooking } from './csmBookingValidators';
import { readTextBody } from '../lib/http-body';

import {
	configuredScope,
	creationScope,
	sameProviderScope,
	type ProviderScope
} from './csmIdentity';
import { historicalBookingInScope, matchesHistoricalCompanyReference } from './csmHistory';
import {
	CalReadError,
	CalRateLimitError,
	retryDelay,
	providerRequestId,
	type CalFailureDetails,
	type CalOperation
} from './csmProviderFailures';
export { CalReadError, CalRateLimitError } from './csmProviderFailures';
export type BookingMode = Infer<typeof bookingMode>;
export type ProviderBooking = Infer<typeof providerBooking>;
export const MEETING_PLACEHOLDER = 'Video link to follow';
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
function operationFor(path: string, method: string): CalOperation {
	return method === 'PATCH'
		? 'locationUpdate'
		: method === 'POST'
			? 'create'
			: path.startsWith('event-types/')
				? 'configuration'
				: path.startsWith('slots?')
					? 'slots'
					: path.startsWith('bookings?')
						? 'bookingList'
						: 'bookingRead';
}
/** No provider body, URL, attendee or credential is included in thrown errors/logs. */
export async function calRequest(
	ctx: ActionCtx,
	path: string,
	version: string,
	method: 'GET' | 'POST' | 'PATCH',
	body?: unknown,
	onDispatch?: () => void
) {
	const operation = operationFor(path, method);
	if (!env.CAL_API_KEY)
		throw new CalReadError('Booking is unavailable.', { operation, category: 'configuration' });
	// Serialize before admission/dispatch: a local failure cannot be mistaken for a sent POST.
	let serialized: string | undefined;
	try {
		serialized = body === undefined ? undefined : JSON.stringify(body);
	} catch {
		throw new CalReadError('Invalid calendar request.', { operation, category: 'body' });
	}
	const admission = await limiter.limit(ctx, 'provider');
	if (!admission.ok) {
		if (!Number.isFinite(admission.retryAfter) || admission.retryAfter < 0)
			throw new CalReadError('Booking is unavailable.', { operation, category: 'quota' });
		throw new CalRateLimitError(admission.retryAfter, { operation, category: 'quota' });
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), body === undefined ? 12_000 : 20_000);
	let responseDetails: CalFailureDetails | undefined;
	try {
		onDispatch?.();
		const response = await fetch(`https://api.cal.com/v2/${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${env.CAL_API_KEY}`,
				'cal-api-version': version,
				'User-Agent': 'Dinu/1.0',
				...(body === undefined ? {} : { 'Content-Type': 'application/json' })
			},
			...(serialized === undefined ? {} : { body: serialized }),
			signal: controller.signal,
			redirect: 'error'
		});
		responseDetails = {
			operation,
			category: 'body',
			status: response.status,
			...(providerRequestId(response.headers)
				? { requestId: providerRequestId(response.headers) }
				: {}),
			...(response.status === 429 || response.headers.has('retry-after')
				? { retryAfter: retryDelay(response.headers.get('retry-after')) }
				: {})
		};
		let result: unknown;
		try {
			const reader = response.body?.getReader();
			const text = reader ? await readTextBody(reader, 2 * 1024 * 1024) : null;
			if (text === null) throw new Error('Invalid body');
			result = JSON.parse(text);
		} catch {
			const details = {
				...responseDetails,
				category: controller.signal.aborted ? ('timeout' as const) : ('body' as const)
			};
			if (body === undefined && response.status === 429)
				throw new CalRateLimitError(responseDetails.retryAfter!, details);
			throw new CalReadError('Invalid calendar response.', details);
		}
		if (body === undefined && !response.ok) {
			const details = { ...responseDetails, category: 'http' as const };
			if (response.status === 429) throw new CalRateLimitError(details.retryAfter!, details);
			throw new CalReadError('The calendar could not be loaded.', details);
		}
		return { ok: response.ok, status: response.status, body: result, details: responseDetails };
	} catch (error) {
		if (error instanceof CalReadError) throw error;
		throw new CalReadError('The calendar request could not be completed.', {
			...(responseDetails ?? { operation }),
			category: controller.signal.aborted ? 'timeout' : 'transport'
		});
	} finally {
		clearTimeout(timer);
	}
}
export async function calRead(ctx: ActionCtx, path: string, version: string): Promise<unknown> {
	const response = await calRequest(ctx, path, version, 'GET');
	if (!object(response.body) || response.body.status !== 'success')
		throw new CalReadError('Invalid calendar response.', {
			...response.details,
			category: 'response'
		});
	return response.body.data;
}
export async function configuration(ctx: ActionCtx, expectedScope?: ProviderScope) {
	const scope = creationScope();
	if (!scope || (expectedScope && !sameProviderScope(scope, expectedScope))) return null;
	const event = await calRead(ctx, `event-types/${scope.eventTypeId}`, '2026-06-12');
	if (
		!object(event) ||
		event.id !== scope.eventTypeId ||
		!Array.isArray(event.users) ||
		!event.users.some((u) => object(u) && u.id === scope.organizerId) ||
		typeof event.lengthInMinutes !== 'number' ||
		!Number.isSafeInteger(event.lengthInMinutes) ||
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
		![1, 2].includes(event.locations.length)
	)
		return null;
	const location = event.locations.find((l) => object(l) && l.type === 'integration');
	const split = event.locations.length === 2;
	if (
		split &&
		(!object(location) ||
			location.integration !== 'google-meet' ||
			event.locations.filter((l) => object(l) && l.type === 'attendeeDefined').length !== 1)
	)
		return null;
	if (
		!object(location) ||
		location.type !== 'integration' ||
		!['google-meet', 'zoom', 'cal-video', 'daily'].includes(String(location.integration))
	)
		return null;
	// A bound is useful only for one recognized enabled window. Unknown/ambiguous windows
	// retain the calendar's existing conservative navigation limit; Cal enforces availability.
	const windows = Array.isArray(event.bookingWindow)
		? event.bookingWindow
		: event.bookingWindow
			? [event.bookingWindow]
			: [];
	const enabled = windows.filter((window) => !object(window) || window.disabled !== true);
	const window = enabled.length === 1 ? enabled[0] : undefined;
	let lastDate: string | null = null;
	if (
		object(window) &&
		window.disabled === false &&
		window.type === 'calendarDays' &&
		typeof window.value === 'number' &&
		Number.isSafeInteger(window.value) &&
		window.value >= 0
	) {
		const date = new Date(Date.now() + (window.value + 1) * 86_400_000);
		if (Number.isFinite(date.getTime())) lastDate = date.toISOString().slice(0, 10);
	}
	return {
		scope,
		duration: event.lengthInMinutes,
		lastDate,
		location: split
			? { type: 'attendeeDefined', location: MEETING_PLACEHOLDER }
			: { type: 'integration', integration: String(location.integration) },
		meetingPolicy: split ? ('google-meet-after-booking' as const) : undefined,
		videoProvider: String(location.integration)
	};
}
export async function slots(
	ctx: ActionCtx,
	start: string,
	end: string,
	timeZone: string,
	duration?: number,
	scope = creationScope()
) {
	if (!scope)
		throw new CalReadError('Booking is unavailable.', {
			operation: 'slots',
			category: 'configuration'
		});
	const q = new URLSearchParams({
		eventTypeId: String(scope.eventTypeId),
		start,
		end,
		timeZone,
		...(duration === undefined ? {} : { duration: String(duration) }),
		format: 'range'
	});
	const data = await calRead(ctx, `slots?${q}`, '2024-09-04');
	const invalid = () =>
		new CalReadError('Invalid calendar response.', { operation: 'slots', category: 'response' });
	if (!object(data)) throw invalid();
	const result: { start: string; end: string }[] = [];
	for (const day of Object.values(data)) {
		if (!Array.isArray(day)) throw invalid();
		for (const slot of day) {
			if (!object(slot)) throw invalid();
			const a = iso(slot.start),
				b = iso(slot.end);
			if (!a || !b || b <= a) throw invalid();
			if (Date.parse(a) > Date.now()) result.push({ start: a, end: b });
			if (result.length > 6000) throw invalid();
		}
	}
	return [...new Map(result.map((s) => [s.start, s])).values()].sort((a, b) =>
		a.start.localeCompare(b.start)
	);
}
/** Validate scope on every API result, including explicitly linked reschedule successors. */
export function bookingInScope(data: Record<string, unknown>, scope?: ProviderScope) {
	return scope
		? data.eventTypeId === scope.eventTypeId &&
				Array.isArray(data.hosts) &&
				data.hosts.some((host) => object(host) && host.id === scope.organizerId)
		: historicalBookingInScope(data);
}
export function parseBooking(
	data: unknown,
	attendeeEmail: string,
	scope?: ProviderScope
): ProviderBooking | null {
	if (
		!object(data) ||
		!validBookingUid(data.uid) ||
		!bookingInScope(data, scope) ||
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
function parseScopedSetupBooking(
	data: unknown,
	uid: string,
	scope?: {
		companyId: string;
		profileId: string;
		providerScope?: ProviderScope;
		attemptReference?: string;
		legacyReference?: string;
	},
	providerScope = scope?.providerScope
): ProviderBooking | null {
	if (
		!object(data) ||
		data.uid !== uid ||
		!validBookingUid(uid) ||
		!bookingInScope(data, providerScope)
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
			metadata.dinuCsmReference !== scope.legacyReference &&
			!matchesHistoricalCompanyReference(
				metadata.dinuCsmReference,
				scope.companyId,
				scope.profileId
			)
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
/** Established appointment proof always uses the original stored scope and association. */
export function parseSetupBooking(
	data: unknown,
	uid: string,
	scope: NonNullable<Parameters<typeof parseScopedSetupBooking>[2]>
) {
	return parseScopedSetupBooking(data, uid, scope);
}
/** Discovery only: locators cannot publish facts or establish ownership. Historical scope
 * remains original; new unassociated reads may follow the explicitly configured scope.
 */
export function parseSetupLocator(data: unknown, uid: string) {
	if (!object(data)) return null;
	const scope = configuredScope();
	return parseScopedSetupBooking(
		data,
		uid,
		undefined,
		scope && bookingInScope(data, scope) ? scope : undefined
	);
}
export function validBookingUid(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/** Only known pre-creation rejections may release an already dispatched request.
 * Version-dependent boundary: ErrorsBookingsService_2024_08_13's exact HTTP 400 mappings.
 * https://github.com/calcom/cal.com/blob/main/apps/api/v2/src/platform/bookings/2024-08-13/services/errors.service.ts
 * The mapping alone cannot prove SaaS error timing; never broaden it to generic status rules.
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
