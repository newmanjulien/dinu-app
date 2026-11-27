import { v, type Infer } from 'convex/values';
import { parse } from 'convex-helpers/validators';
import { readTextBody } from '../http-body';
import { isBuyerCode } from './token';
import { validTrackingId } from './tracking';

export const singleActivityRequest = v.union(
	v.object({
		kind: v.literal('active'),
		token: v.string(),
		browserId: v.string(),
		openingId: v.string()
	}),
	v.object({
		kind: v.literal('open'),
		token: v.string(),
		browserId: v.string(),
		openingId: v.string()
	}),
	v.object({
		kind: v.literal('clause'),
		token: v.string(),
		browserId: v.string(),
		openingId: v.string(),
		eventId: v.string(),
		sequence: v.number(),
		itemId: v.string()
	})
);
export const clauseBatchRequest = v.object({
	kind: v.literal('clauses'),
	token: v.string(),
	browserId: v.string(),
	openingId: v.string(),
	events: v.array(v.object({ eventId: v.string(), sequence: v.number(), itemId: v.string() }))
});
export const activityRequest = v.union(...singleActivityRequest.members, clauseBatchRequest);
type BuyerActivityRequest = Infer<typeof singleActivityRequest>;
type ClauseBatchRequest = Infer<typeof clauseBatchRequest>;
export const MAX_CLAUSE_BATCH = 8;

/** Shape validation is shared with Convex; access remains authoritative at intake. */
export function validActivity(request: BuyerActivityRequest) {
	return (
		isBuyerCode(request.token) &&
		validTrackingId(request.browserId) &&
		validTrackingId(request.openingId) &&
		(request.kind !== 'clause' ||
			(validTrackingId(request.eventId) &&
				Number.isSafeInteger(request.sequence) &&
				request.sequence > 0 &&
				request.itemId.length > 0 &&
				request.itemId.length <= 128))
	);
}

export function validClauseBatch(request: ClauseBatchRequest) {
	return (
		request.events.length > 0 &&
		request.events.length <= MAX_CLAUSE_BATCH &&
		request.events.every((event) =>
			validActivity({
				kind: 'clause',
				token: request.token,
				browserId: request.browserId,
				openingId: request.openingId,
				...event
			})
		) &&
		request.events.every((event, index) =>
			index === 0 ? true : event.sequence > request.events[index - 1].sequence
		)
	);
}

export async function readActivity(
	request: Request
): Promise<BuyerActivityRequest | ClauseBatchRequest | null> {
	if (!request.headers.get('content-type')?.startsWith('application/json')) return null;
	const reader = request.body?.getReader();
	if (!reader) return null;
	try {
		const text = await readTextBody(reader, 4096);
		if (text === null) return null;
		const value = parse(activityRequest, JSON.parse(text));
		return value.kind === 'clauses'
			? validClauseBatch(value)
				? value
				: null
			: validActivity(value)
				? value
				: null;
	} catch {
		return null;
	}
}
