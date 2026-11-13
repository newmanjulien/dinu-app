import { ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
/** The only boundary for previously issued URLs/references and their original provider identity.
 * Copy the OLD delivery key to CAL_LEGACY_METADATA_SECRET before rotating delivery signing.
 * Missing historical proof remains unresolved; current configuration never reinterprets it.
 */
import { env } from './_generated/server';
import {
	frozenAttemptReference,
	signReference,
	verifySignature,
	type AttemptIdentity,
	type ProviderScope
} from './csmIdentity';
import type { Infer } from 'convex/values';
import type { bookingMode } from './csmBookingValidators';
import type { ConfirmedSetupBooking } from './csmSetupState';

type BookingMode = Infer<typeof bookingMode>;
export const HISTORICAL_EVENT_ID = 2928313;
const HISTORICAL_ORGANIZER = 'juliennewman';
const HISTORICAL_SLUG = 'julien';
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
export function historicalBookingInScope(data: Record<string, unknown>) {
	return (
		data.eventTypeId === HISTORICAL_EVENT_ID &&
		Array.isArray(data.hosts) &&
		data.hosts.some((host) => record(host) && host.username === HISTORICAL_ORGANIZER) &&
		(!record(data.eventType) || data.eventType.slug === HISTORICAL_SLUG)
	);
}
/** Only authenticated provider facts matching the ORIGINAL identity may freeze its numeric IDs. */
export function historicalProviderScope(data: Record<string, unknown>): ProviderScope | null {
	if (!historicalBookingInScope(data) || !Array.isArray(data.hosts)) return null;
	const host = data.hosts.find((host) => record(host) && host.username === HISTORICAL_ORGANIZER);
	return record(host) && typeof host.id === 'number' && Number.isSafeInteger(host.id) && host.id > 0
		? { eventTypeId: HISTORICAL_EVENT_ID, organizerId: host.id }
		: null;
}
function companyMessage(companyId: string, mode: BookingMode, profileId?: string) {
	return profileId
		? `csm-source:v1:${env.CONVEX_CLOUD_URL}:${mode}:${companyId}:${profileId}`
		: `csm-booking:v2:${env.CONVEX_CLOUD_URL}:${mode}:${companyId}`;
}
export function matchesHistoricalCompanyReference(
	reference: unknown,
	companyId: string,
	profileId: string
) {
	if (typeof reference !== 'string' || !env.CAL_LEGACY_METADATA_SECRET) return false;
	const parts = reference.split('.');
	if (
		(parts.length !== 3 && parts.length !== 4) ||
		parts[0] !== companyId ||
		parts[1] !== 'setup' ||
		(parts.length === 4 && parts[2] !== profileId)
	)
		return false;
	return (
		parts.at(-1) ===
		signReference(
			env.CAL_LEGACY_METADATA_SECRET,
			companyMessage(companyId, 'setup', parts.length === 4 ? profileId : undefined)
		)
	);
}
export async function parseCompanyReference(reference: string) {
	const parts = reference.split('.');
	if (
		!env.CAL_LEGACY_METADATA_SECRET ||
		(parts.length !== 3 && parts.length !== 4) ||
		(parts[1] !== 'setup' && parts[1] !== 'support')
	)
		return null;
	const [companyId, mode] = parts as [string, BookingMode];
	const profileId = parts.length === 4 ? parts[2] : undefined;
	return (await verifySignature(
		env.CAL_LEGACY_METADATA_SECRET,
		companyMessage(companyId, mode, profileId),
		parts.at(-1)!
	))
		? { companyId, mode, profileId }
		: null;
}
export function attemptReference(a: AttemptIdentity): string | null {
	// Never reinterpret a partial/invalid new envelope as a legacy attempt.
	if (
		a.attemptReference !== undefined ||
		a.providerScope !== undefined ||
		a.dispatchId !== undefined
	)
		return frozenAttemptReference(a);
	if (
		!env.CAL_LEGACY_METADATA_SECRET ||
		(a.eventTypeId !== undefined && a.eventTypeId !== HISTORICAL_EVENT_ID)
	)
		return null;
	const message = `csm-attempt:v1:${env.CONVEX_CLOUD_URL}:${a.companyId}:${a.mode}:${a.requestedStart}:${a._id}`;
	return `${a._id}.${signReference(env.CAL_LEGACY_METADATA_SECRET, message)}`;
}

/** Historical terminal rows must be normalized before admitting another creation. */
export async function assertHistoricalAdmission(ctx: QueryCtx, membershipId: Id<'memberships'>) {
	const legacyFailures = await Promise.all(
		([undefined, 1] as const).map((format) =>
			ctx.db
				.query('csmBookingAttempts')
				.withIndex('by_membershipId_and_state_and_format', (q) =>
					q.eq('membershipId', membershipId).eq('state', 'failed').eq('format', format)
				)
				.first()
		)
	);
	const unconfirmed = await ctx.db
		.query('csmBookingAttempts')
		.withIndex('by_membershipId_and_state_and_confirmation', (q) =>
			q.eq('membershipId', membershipId).eq('state', 'booked').eq('confirmation', undefined)
		)
		.first();
	if (legacyFailures.some(Boolean) || unconfirmed)
		throw new ConvexError('An earlier booking needs to be checked. Please contact support.');
}

/** Compatibility reads accept complete evidence, never a marker paired with pending dates. */
export async function readHistoricalConfirmedBooking(
	ctx: QueryCtx,
	a: Doc<'csmSetupAppointments'>
): Promise<ConfirmedSetupBooking | null> {
	if (
		a.status !== 'checking' &&
		(a.bookingConfirmation === undefined || a.bookingConfirmation === a.status) &&
		a.observedAt !== undefined &&
		a.providerUpdatedAt !== undefined
	)
		return {
			status: a.status,
			uid: a.currentUid,
			start: a.start,
			end: a.end,
			confirmedAt: a.observedAt,
			providerUpdatedAt: a.providerUpdatedAt
		};
	// A just-created appointment has not received its first provider observation yet.
	if (
		a.bookingConfirmation !== 'accepted' ||
		a.observedAt !== undefined ||
		a.providerUpdatedAt !== undefined ||
		!a.attemptId
	)
		return null;
	const attempt = await ctx.db.get('csmBookingAttempts', a.attemptId);
	const confirmation = attempt?.confirmation;
	if (
		!attempt ||
		attempt.mode !== 'setup' ||
		attempt.companyId !== a.companyId ||
		attempt.profileId !== a.profileId ||
		!confirmation ||
		confirmation.uid !== a.currentUid
	)
		return null;
	return { status: 'accepted', ...confirmation };
}

/** The old single-hint field is read only at this conversion boundary. */
export function historicalSuccessorHint(row: { successorHint?: string }) {
	return row.successorHint;
}

/** Legacy graphs supply bounded locators/display recovery only, never settlement authority. */
export function historicalAttemptLocators(a: Doc<'csmBookingAttempts'>) {
	return (a.lineage ?? []).map((booking) => booking.uid);
}
export function historicalAttemptStart(a: Doc<'csmBookingAttempts'>) {
	return a.lineage?.find((booking) => booking.uid === a.providerUid)?.start;
}
