import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { linkBlocked } from './hubspotRecords';

export const CLAIM_MS = 5 * 60_000;
export const OBSERVATION_MS = 24 * 60 * 60_000;
export function observationExpired(event: Doc<'hubspotEvents'>, now: number) {
	return Boolean(
		event.dispatch && now >= (event.dispatchedAt ?? event._creationTime) + OBSERVATION_MS
	);
}
export function sameDestination(
	link: Doc<'savedContracts'>['hubspot'],
	event: Doc<'hubspotEvents'>
) {
	const d = event.destination;
	return Boolean(
		link &&
		link.connectionId === d.connectionId &&
		link.accountId === d.accountId &&
		link.dealId === d.dealId &&
		link.generation === d.generation
	);
}
/** Projection absence is not deletion. All readers run in the caller's transaction. */
export async function deliveryFacts(ctx: QueryCtx, event: Doc<'hubspotEvents'>) {
	const directory = await ctx.db
		.query('contractDirectory')
		.withIndex('by_contractId', (q) => q.eq('contractId', event.contractId))
		.unique();
	const current = directory ?? (await ctx.db.get('savedContracts', event.contractId));
	const connection = await ctx.db.get('hubspotConnections', event.destination.connectionId);
	const accountValid = Boolean(
		connection &&
		connection.companyId === event.companyId &&
		connection.accountId === event.destination.accountId
	);
	const linkValid =
		(!current ||
			(current.companyId === event.companyId &&
				sameDestination(current.hubspot, event) &&
				current.hubspot?.availability === 'available')) &&
		!(await linkBlocked(ctx, event.contractId, event.destination.generation));
	return { connection, accountValid, linkValid };
}
export function deliveryMode(
	event: Doc<'hubspotEvents'>,
	facts: Awaited<ReturnType<typeof deliveryFacts>>,
	now: number
) {
	if (observationExpired(event, now) && !event.operatorObservation) return 'attention';
	if (!event.dispatch && !facts.linkValid) return 'paused';
	if (!facts.accountValid || facts.connection?.status !== 'connected') return 'blocked';
	return event.dispatch ? 'observe' : 'fresh';
}
