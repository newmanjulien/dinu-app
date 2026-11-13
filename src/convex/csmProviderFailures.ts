export type CalOperation =
	'configuration' | 'slots' | 'bookingRead' | 'bookingList' | 'create' | 'locationUpdate';
export type CalFailureCategory =
	'configuration' | 'quota' | 'transport' | 'timeout' | 'body' | 'http' | 'response';
export type CalFailureDetails = {
	operation: CalOperation;
	category: CalFailureCategory;
	status?: number;
	requestId?: string;
	retryAfter?: number;
};
/** Safe bounded diagnostics only: no response body, URL, credentials or personal evidence. */
export class CalReadError extends Error {
	readonly details: CalFailureDetails;
	constructor(
		message: string,
		details: CalFailureDetails = { operation: 'bookingRead', category: 'response' }
	) {
		super(message);
		this.name = 'CalReadError';
		this.details = details;
	}
}
export class CalRateLimitError extends CalReadError {
	constructor(
		readonly retryAfter: number,
		details: Omit<CalFailureDetails, 'retryAfter'> = { operation: 'bookingRead', category: 'quota' }
	) {
		super('The calendar is busy. Try again shortly.', { ...details, retryAfter });
		this.name = 'CalRateLimitError';
	}
}
export function retryDelay(value: string | null, now = Date.now()) {
	const delay =
		value && /^\d+(?:\.\d+)?$/.test(value.trim())
			? Number(value) * 1000
			: value
				? Date.parse(value) - now
				: NaN;
	return Number.isFinite(delay) && delay >= 0
		? Math.max(1000, Math.min(Math.ceil(delay), 24 * 60 * 60_000))
		: 60_000;
}
export function providerRequestId(headers: Headers) {
	const value = headers.get('x-cal-request-id') ?? headers.get('x-request-id');
	return value && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}
