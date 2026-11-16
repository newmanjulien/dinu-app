/** An identity belongs to one deliberate intent and its exact original input bytes. */
export const OPERATION_RETRY_MS = 7 * 24 * 60 * 60_000;
export const OPERATION_CLEANUP_GRACE_MS = 24 * 60 * 60_000;
export const OPERATION_FUTURE_TOLERANCE_MS = 60_000;
export type OperationIdentity = { createdAt: number; retryUntil: number; gcAfter: number };

/** Pure: safe in reactive queries, persisted-value validation and key construction. */
export function parseOperationId(value: string): OperationIdentity | null {
	const match =
		/^op1:(0|[1-9]\d*):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(
			value
		);
	if (!match) return null;
	const createdAt = Number(match[1]);
	const retryUntil = createdAt + OPERATION_RETRY_MS;
	const gcAfter = retryUntil + OPERATION_CLEANUP_GRACE_MS;
	return Number.isSafeInteger(createdAt) && Number.isSafeInteger(gcAfter)
		? { createdAt, retryUntil, gcAfter }
		: null;
}

/** Call only when creating a new intent, never to recover or retry an existing one. */
export function createOperationId(createdAt = Date.now()): string {
	const id = `op1:${createdAt}:${crypto.randomUUID()}`;
	if (!parseOperationId(id)) throw new Error('Invalid operation creation time.');
	return id;
}

export function operationKey(scope: string, kind: string, id: string): string {
	if (!parseOperationId(id)) throw new Error('Invalid operation identity.');
	return JSON.stringify([scope, kind, id]);
}
