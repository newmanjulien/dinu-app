import { ConvexError, type Infer } from 'convex/values';
import { isSenderExecutionTerminal, type legacyCsmAttempt } from './csmBookingValidators';
import { iso, validBookingUid } from './csmCal';

export function validOperator(
	a: { operator: string; evidence: string; reason: string } | undefined
) {
	return !!a && [a.operator, a.evidence, a.reason].every((s) => !!s.trim() && s.length <= 2000);
}
/** All terminal transitions require the evidence owned by that provider protocol. */
type AttemptFields = Omit<Infer<typeof legacyCsmAttempt>, 'format'>;
/** Only proven noncreation or a completed sender's scoped negative evidence permits retry. */
export function safeFailedEvidence(a: AttemptFields) {
	if (a.state !== 'failed' || !a.error) return false;
	switch (a.failureBasis) {
		case 'queuedPreflight':
		case 'queuedExpired':
		case 'claimedPredispatch':
		case 'providerRejection':
			return true;
		case 'providerTerminal':
			return isSenderExecutionTerminal(a.senderTerminal?.kind) && validBookingUid(a.providerUid);
		case 'providerInvestigation':
			return (
				isSenderExecutionTerminal(a.senderTerminal?.kind) && validOperator(a.operatorResolution)
			);
		default:
			return false;
	}
}
export function confirmedEvidence(a: AttemptFields) {
	return (
		!!a.confirmation &&
		validBookingUid(a.confirmation.uid) &&
		iso(a.confirmation.start) === a.confirmation.start &&
		iso(a.confirmation.end) === a.confirmation.end &&
		a.confirmation.end > a.confirmation.start &&
		Number.isFinite(a.confirmation.confirmedAt)
	);
}
export function canonicalState(a: AttemptFields) {
	const format = 2 as const;
	if (a.state === 'booked') {
		if (!a.confirmation || !confirmedEvidence(a))
			throw new ConvexError('A booked attempt requires confirmed provider evidence.');
		return {
			format,
			state: a.state,
			confirmation: a.confirmation,
			error: undefined,
			failureBasis: undefined
		};
	}
	if (a.state === 'failed') {
		if (!safeFailedEvidence(a))
			throw new ConvexError('A failed attempt requires evidence that permits another attempt.');
		if (a.failureBasis === 'providerTerminal') {
			return {
				format,
				state: a.state,
				error: a.error,
				failureBasis: a.failureBasis,
				senderTerminal: a.senderTerminal,
				providerUid: a.providerUid,
				confirmation: undefined
			};
		}
		if (a.failureBasis === 'providerInvestigation') {
			return {
				format,
				state: a.state,
				error: a.error,
				failureBasis: a.failureBasis,
				senderTerminal: a.senderTerminal,
				operatorResolution: a.operatorResolution!,
				confirmation: undefined
			};
		}
		return {
			format,
			state: a.state,
			error: a.error,
			failureBasis: a.failureBasis,
			confirmation: undefined
		};
	}
	return {
		format,
		state: a.state,
		error: a.error,
		failureBasis: undefined,
		confirmation: undefined
	};
}
