import { ConvexError } from 'convex/values';
import { parseOperationId } from './operation-identity';
import { errorCode } from './work-policy';

export const OPERATION_RECOVERY_MESSAGE =
	'This request can no longer be retried. Your original changes are still here. Review the current saved state before making a new request.';

/** A local clock can stop retries, but only server admission can authorize them. */
export function assertOperationRetryable(operationId: string, retryUntil?: number) {
	const identity = parseOperationId(operationId);
	if (!identity || (retryUntil !== undefined && retryUntil !== identity.retryUntil))
		throw new ConvexError({ code: 'OPERATION_INVALID', message: OPERATION_RECOVERY_MESSAGE });
	if (Date.now() >= identity.retryUntil)
		throw new ConvexError({ code: 'OPERATION_EXPIRED', message: OPERATION_RECOVERY_MESSAGE });
	return identity.retryUntil;
}

export function isOperationRecovery(error: unknown) {
	return ['OPERATION_INVALID', 'OPERATION_EXPIRED', 'OPERATION_FUTURE'].includes(
		errorCode(error) ?? ''
	);
}

export class OperationResultFailure extends ConvexError<
	string | { code: string; message: string }
> {}

export function operationResultError(value: { error: string; errorCode?: string }) {
	return new OperationResultFailure(
		value.errorCode ? { code: value.errorCode, message: OPERATION_RECOVERY_MESSAGE } : value.error
	);
}
