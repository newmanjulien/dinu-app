import { v, type Infer } from 'convex/values';
import { parse } from 'convex-helpers/validators';
import { readTextBody } from '../http-body';
import { isBuyerToken } from './token';
import { validTrackingId } from './tracking';

export const activityRequest = v.union(
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
type BuyerActivityRequest = Infer<typeof activityRequest>;

/** Shape validation is shared with Convex; access remains authoritative at intake. */
export function validActivity(request: BuyerActivityRequest) {
	return (
		isBuyerToken(request.token) &&
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

export async function readActivity(request: Request): Promise<BuyerActivityRequest | null> {
	if (!request.headers.get('content-type')?.startsWith('application/json')) return null;
	const reader = request.body?.getReader();
	if (!reader) return null;
	try {
		const text = await readTextBody(reader, 2048);
		if (text === null) return null;
		const value = parse(activityRequest, JSON.parse(text));
		return validActivity(value) ? value : null;
	} catch {
		return null;
	}
}
