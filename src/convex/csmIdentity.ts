import { env } from './_generated/server';
import type { Infer } from 'convex/values';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { bookingMode, providerScope } from './csmBookingValidators';

export type ProviderScope = Infer<typeof providerScope>;
const encoder = new TextEncoder();
function positiveId(value: string | undefined) {
	if (!value || !/^[1-9]\d*$/.test(value)) return null;
	const id = Number(value);
	return Number.isSafeInteger(id) ? id : null;
}
/** Setup and support intentionally share this one explicitly configured event. */
export function configuredScope(): ProviderScope | null {
	const eventTypeId = positiveId(env.CAL_EVENT_TYPE_ID);
	const organizerId = positiveId(env.CAL_ORGANIZER_ID);
	return eventTypeId && organizerId ? { eventTypeId, organizerId } : null;
}
export function creationScope(): ProviderScope | null {
	return env.CAL_API_KEY?.trim() &&
		env.CAL_WEBHOOK_SECRET?.trim() &&
		env.CAL_METADATA_SIGNING_SECRET?.trim()
		? configuredScope()
		: null;
}
export function validProviderScope(scope: ProviderScope | undefined): scope is ProviderScope {
	return (
		!!scope &&
		Number.isSafeInteger(scope.eventTypeId) &&
		scope.eventTypeId > 0 &&
		Number.isSafeInteger(scope.organizerId) &&
		scope.organizerId > 0
	);
}
export function sameProviderScope(a: ProviderScope, b: ProviderScope) {
	return a.eventTypeId === b.eventTypeId && a.organizerId === b.organizerId;
}
export function signReference(secret: string, message: string) {
	return bytesToHex(hmac(sha256, encoder.encode(secret), encoder.encode(message)));
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
export type AttemptIdentity = {
	_id: string;
	companyId: string;
	profileId: string;
	membershipId: string;
	mode: Infer<typeof bookingMode>;
	requestedStart: string;
	timeZone: string;
	replacement?: { appointmentId: string; currentUid: string };
	providerScope?: ProviderScope;
	dispatchId?: string;
	attemptReference?: string;
	eventTypeId?: number;
};
/** Opaque identity only, not an authorization token. Math.random is transactional in Convex. */
export function newDispatchId() {
	return Array.from({ length: 4 }, () =>
		Math.floor(Math.random() * 0x100000000)
			.toString(16)
			.padStart(8, '0')
	).join('');
}
/** Called once in the insertion transaction, before any sender is scheduled. */
export function newAttemptReference(a: AttemptIdentity) {
	if (
		!env.CAL_METADATA_SIGNING_SECRET ||
		!validProviderScope(a.providerScope) ||
		!a.dispatchId ||
		!/^[a-f\d]{32}$/.test(a.dispatchId)
	)
		throw new Error('Booking is unavailable.');
	const message = JSON.stringify([
		'csm-attempt:v2',
		env.CONVEX_CLOUD_URL,
		a.mode,
		a.requestedStart,
		a.timeZone,
		a.companyId,
		a.profileId,
		a.membershipId,
		a._id,
		a.dispatchId,
		a.providerScope.eventTypeId,
		a.providerScope.organizerId,
		a.replacement?.appointmentId ?? null,
		a.replacement?.currentUid ?? null
	]);
	return `${a._id}.v2.${a.dispatchId}.${signReference(env.CAL_METADATA_SIGNING_SECRET, message)}`;
}
/** Persisted references are immutable evidence; today's signing key does not reverify history. */
export function frozenAttemptReference(a: AttemptIdentity) {
	if (!validProviderScope(a.providerScope) || !a.attemptReference) return null;
	const suffix = a.attemptReference.split('.').at(-1) ?? '';
	const native =
		a.dispatchId &&
		/^[a-f\d]{32}$/.test(a.dispatchId) &&
		a.attemptReference === `${a._id}.v2.${a.dispatchId}.${suffix}`;
	const normalizedHistory = a.attemptReference === `${a._id}.${suffix}`;
	return (native || normalizedHistory) && /^[a-f\d]{64}$/.test(suffix) ? a.attemptReference : null;
}
export function attemptIdFromReference(reference: string) {
	const parts = reference.split('.');
	return (parts.length === 2 && /^[a-f\d]{64}$/i.test(parts[1])) ||
		(parts.length === 4 &&
			parts[1] === 'v2' &&
			/^[a-f\d]{32}$/.test(parts[2]) &&
			/^[a-f\d]{64}$/.test(parts[3]))
		? parts[0]
		: null;
}
