import { ConvexError, v, type Infer } from 'convex/values';
import {
	clauseBatchRequest,
	singleActivityRequest,
	validActivity,
	validClauseBatch
} from '../lib/buyer/activity-transport';
import { ACTIVITY_RETENTION } from '../lib/buyer/tracking';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalMutation, query, type MutationCtx } from './_generated/server';
import { memberForCompany } from './auth';
import { consumeActivityQuota } from './buyerActivityQuota';
import { deviceCategory } from './buyerActivityValidators';
import { resolve, seller } from './buyerLinks';
import { cleanupBudget } from './cleanup';
import { versionReader } from './templates';

const MAX_OPENING_EVENTS = 1000;
const VISIT_IDLE_MS = 30 * 60_000;
const recordResult = v.union(
	v.object({ kind: v.literal('recorded'), expiresAt: v.optional(v.number()) }),
	v.object({ kind: v.literal('unavailable') }),
	v.object({ kind: v.literal('limited'), retryAfter: v.number() })
);

async function allocateVisitorNumber(
	ctx: MutationCtx,
	contract: Pick<Doc<'savedContracts'>, '_id' | 'companyId'>
) {
	const counter = await ctx.db
		.query('buyerActivityCounters')
		.withIndex('by_contractId', (q) => q.eq('contractId', contract._id))
		.unique();
	const number = counter?.nextVisitorNumber ?? 1;
	if (counter)
		await ctx.db.patch('buyerActivityCounters', counter._id, { nextVisitorNumber: number + 1 });
	else
		await ctx.db.insert('buyerActivityCounters', {
			companyId: contract.companyId,
			contractId: contract._id,
			nextVisitorNumber: number + 1
		});
	return number;
}
function changed(): never {
	throw new ConvexError('Activity changed during delivery.');
}

async function visitFor(ctx: MutationCtx, opening: Doc<'buyerActivityOpenings'>) {
	return opening.visitId ? await ctx.db.get('buyerActivityOpenings', opening.visitId) : opening;
}

async function latestVisit(
	ctx: MutationCtx,
	opening: Pick<Doc<'buyerActivityOpenings'>, 'contractId' | 'browserId' | 'profileId'>
) {
	const history = ctx.db.query('buyerActivityOpenings');
	const latest = await (
		opening.profileId
			? history.withIndex('by_contractId_and_profileId_and_acceptedAt', (q) =>
					q.eq('contractId', opening.contractId).eq('profileId', opening.profileId)
				)
			: history.withIndex('by_contractId_and_browserId_and_profileId_and_acceptedAt', (q) =>
					q
						.eq('contractId', opening.contractId)
						.eq('browserId', opening.browserId)
						.eq('profileId', undefined)
				)
	)
		.order('desc')
		.first();
	return latest ? await visitFor(ctx, latest) : null;
}

/** Vercel supplies a URI-encoded city through the secret server intake only. */
function openingCity(value?: string) {
	if (!value || value.length > 768) return undefined;
	try {
		const city = decodeURIComponent(value).normalize('NFC').trim().replace(/\s+/gu, ' ');
		return city && city.length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(city) ? city : undefined;
	} catch {
		return undefined;
	}
}

/** Shared single-event intake so a clause batch commits in one transaction. */
async function recordOne(
	ctx: MutationCtx,
	request: Infer<typeof singleActivityRequest>,
	device?: Infer<typeof deviceCategory>,
	city?: string
) {
	if (!validActivity(request)) throw new ConvexError('Invalid activity.');
	if (request.kind === 'clause')
		return (
			await recordClauses(ctx, {
				kind: 'clauses',
				token: request.token,
				browserId: request.browserId,
				openingId: request.openingId,
				events: [{ eventId: request.eventId, sequence: request.sequence, itemId: request.itemId }]
			})
		).results[0] as Infer<typeof recordResult>;
	const resolved = await resolve(ctx, request.token);
	if (!resolved) return { kind: 'unavailable' as const };
	const { link, contract } = resolved;
	const member = await memberForCompany(ctx, contract.companyId);
	const profileId = member?.profile._id;
	const now = Date.now();
	const opening = await ctx.db
		.query('buyerActivityOpenings')
		.withIndex('by_contractId_and_openingId', (q) =>
			q.eq('contractId', contract._id).eq('openingId', request.openingId)
		)
		.unique();
	if (
		opening &&
		(opening.browserId !== request.browserId ||
			opening.linkId !== link._id ||
			opening.profileId !== profileId)
	)
		changed();
	if (opening && opening.expiresAt <= now) return { kind: 'unavailable' as const };
	if (request.kind === 'open') {
		if (opening) return { kind: 'recorded' as const, expiresAt: opening.expiresAt };
		const retryAfter = await consumeActivityQuota(ctx, link, request.browserId);
		if (retryAfter !== null) return { kind: 'limited' as const, retryAfter };
		const previous = await latestVisit(ctx, {
			contractId: contract._id,
			browserId: request.browserId,
			profileId
		});
		const returning = Boolean(previous && previous.expiresAt > now);
		const sameVisit =
			previous &&
			returning &&
			now - (previous.lastActivityAt ?? previous.lastClauseAt ?? previous.acceptedAt) <
				VISIT_IDLE_MS;
		const visitorNumber =
			returning && previous ? previous.visitorNumber : await allocateVisitorNumber(ctx, contract);
		const expiresAt = sameVisit ? previous.expiresAt : now + ACTIVITY_RETENTION;
		await ctx.db.insert('buyerActivityOpenings', {
			companyId: link.companyId,
			contractId: contract._id,
			linkId: link._id,
			browserId: request.browserId,
			profileId,
			openingId: request.openingId,
			...(sameVisit ? { visitId: previous._id } : { lastActivityAt: now }),
			acceptedAt: now,
			expiresAt,
			visitorNumber,
			returning,
			clauseCount: 0,
			eventCount: 0,
			device,
			city: sameVisit ? undefined : openingCity(city)
		});
		if (sameVisit)
			await ctx.db.patch('buyerActivityOpenings', previous._id, { lastActivityAt: now });
		return { kind: 'recorded' as const, expiresAt };
	}
	if (!opening) return { kind: 'unavailable' as const };
	const visit = await visitFor(ctx, opening);
	if (!visit || visit.expiresAt <= now) return { kind: 'unavailable' as const };
	if (request.kind === 'active') {
		const retryAfter = await consumeActivityQuota(ctx, link, request.browserId);
		if (retryAfter !== null) return { kind: 'limited' as const, retryAfter };
		const latest = await latestVisit(ctx, opening);
		if (latest && latest.expiresAt > now)
			await ctx.db.patch('buyerActivityOpenings', latest._id, { lastActivityAt: now });
		return { kind: 'recorded' as const };
	}
	throw new Error('Unexpected activity kind.');
}

async function recordClauses(ctx: MutationCtx, request: Infer<typeof clauseBatchRequest>) {
	const unavailable = () => ({
		results: request.events.map(() => ({ kind: 'unavailable' as const }))
	});
	const resolved = await resolve(ctx, request.token);
	if (!resolved) return unavailable();
	const { link, view, contract } = resolved;
	const [member, opening] = await Promise.all([
		memberForCompany(ctx, contract.companyId),
		ctx.db
			.query('buyerActivityOpenings')
			.withIndex('by_contractId_and_openingId', (q) =>
				q.eq('contractId', contract._id).eq('openingId', request.openingId)
			)
			.unique()
	]);
	const now = Date.now();
	if (
		opening &&
		(opening.browserId !== request.browserId ||
			opening.linkId !== link._id ||
			opening.profileId !== member?.profile._id)
	)
		changed();
	if (!opening || opening.expiresAt <= now) return unavailable();
	const visit = await visitFor(ctx, opening);
	if (!visit || visit.expiresAt <= now) return unavailable();
	const receipts = await Promise.all(
		request.events.map((event) =>
			ctx.db
				.query('buyerActivityReceipts')
				.withIndex('by_contractId_and_eventId', (q) =>
					q.eq('contractId', contract._id).eq('eventId', event.eventId)
				)
				.unique()
		)
	);
	receipts.forEach((receipt, index) => {
		const event = request.events[index];
		if (
			receipt &&
			(receipt.openingId !== visit._id ||
				receipt.sequence !== event.sequence ||
				receipt.itemId !== event.itemId)
		)
			changed();
	});
	const newEvents = request.events.filter((_, index) => !receipts[index]);
	if (!newEvents.length)
		return { results: request.events.map(() => ({ kind: 'recorded' as const })) };
	const eventIds = new Set<string>();
	for (const event of newEvents) {
		if (eventIds.has(event.eventId)) changed();
		eventIds.add(event.eventId);
	}
	const ids = [
		...new Set(
			newEvents
				.map((event) => ctx.db.normalizeId('playbookItems', event.itemId))
				.filter((id): id is NonNullable<typeof id> => id !== null)
		)
	];
	const reader = await versionReader(ctx, view.templateVersionId, link.companyId, true);
	const items = await reader.readItemsByIds(ids);
	const validIds = new Set(
		items
			.filter((item) => item.audience === 'buyer' && item.explanation.trim())
			.map((item) => String(item._id))
	);
	const eligible = newEvents.filter((event) => validIds.has(event.itemId));
	const accepted = eligible.slice(0, Math.max(0, MAX_OPENING_EVENTS - visit.eventCount));
	const retryAfter = accepted.length
		? await consumeActivityQuota(ctx, link, request.browserId, accepted.length)
		: null;
	const inserted = retryAfter === null ? accepted : [];
	if (inserted.length) {
		const itemIds = [...new Set(inserted.map((event) => event.itemId))];
		const [previous, latest] = await Promise.all([
			Promise.all(
				itemIds.map((itemId) =>
					ctx.db
						.query('buyerActivityReceipts')
						.withIndex('by_openingId_and_itemId', (q) =>
							q.eq('openingId', visit._id).eq('itemId', itemId)
						)
						.first()
				)
			),
			latestVisit(ctx, opening)
		]);
		await Promise.all(
			inserted.map((event) =>
				ctx.db.insert('buyerActivityReceipts', {
					companyId: link.companyId,
					contractId: contract._id,
					openingId: visit._id,
					expiresAt: visit.expiresAt,
					...event
				})
			)
		);
		await Promise.all([
			ctx.db.patch('buyerActivityOpenings', visit._id, {
				clauseCount: visit.clauseCount + previous.filter((row) => !row).length,
				eventCount: visit.eventCount + inserted.length,
				lastClauseAt: now,
				lastActivityAt: now
			}),
			latest && latest._id !== visit._id && latest.expiresAt > now
				? ctx.db.patch('buyerActivityOpenings', latest._id, { lastActivityAt: now })
				: Promise.resolve()
		]);
	}
	const acceptedIds = new Set(inserted.map((event) => event.eventId));
	let limited = false;
	const results: (Infer<typeof recordResult> | { kind: 'deferred' })[] = request.events.map(
		(event, index) => {
			if (limited) return { kind: 'deferred' };
			if (receipts[index] || acceptedIds.has(event.eventId)) return { kind: 'recorded' };
			if (!validIds.has(event.itemId)) return { kind: 'unavailable' };
			limited = true;
			return { kind: 'limited', retryAfter: retryAfter ?? 60 };
		}
	);
	return { results };
}

/** Secret intake only. Deduplication and summaries commit in one transaction. */
export const record = internalMutation({
	args: {
		request: singleActivityRequest,
		device: v.optional(deviceCategory),
		city: v.optional(v.string())
	},
	returns: recordResult,
	handler: (ctx, { request, device, city }) => recordOne(ctx, request, device, city)
});

export const recordBatch = internalMutation({
	args: { request: clauseBatchRequest },
	returns: v.object({
		results: v.array(v.union(recordResult, v.object({ kind: v.literal('deferred') })))
	}),
	handler: async (ctx, { request }) => {
		if (!validClauseBatch(request)) throw new ConvexError('Invalid activity batch.');
		return recordClauses(ctx, request);
	}
});

/** Reactive activity; clients filter retention using their display clock. */
export const recent = query({
	args: { id: v.id('savedContracts') },
	returns: v.array(
		v.object({
			id: v.string(),
			at: v.number(),
			expiresAt: v.number(),
			visitorNumber: v.number(),
			type: v.union(v.literal('link_opened'), v.literal('clause_opened')),
			returning: v.boolean(),
			clauseCount: v.number(),
			device: v.optional(deviceCategory),
			city: v.optional(v.string()),
			actor: v.optional(v.union(v.literal('You'), v.literal('Colleague')))
		})
	),
	handler: async (ctx, args) => {
		const { access } = await seller(ctx, args);
		const openings = await ctx.db
			.query('buyerActivityOpenings')
			.withIndex('by_contractId_and_visitId_and_expiresAt', (q) =>
				q.eq('contractId', args.id).eq('visitId', undefined)
			)
			.order('desc')
			.take(10);
		const rows = [];
		for (const opening of openings) {
			const shared = {
				visitorNumber: opening.visitorNumber,
				returning: opening.returning,
				clauseCount: opening.clauseCount,
				expiresAt: opening.expiresAt,
				device: opening.device,
				city: opening.city,
				actor: opening.profileId
					? opening.profileId === access.profile._id
						? ('You' as const)
						: ('Colleague' as const)
					: undefined
			};
			rows.push({
				...shared,
				id: `${opening._id}:opened`,
				at: opening.acceptedAt,
				type: 'link_opened' as const
			});
			if (opening.lastClauseAt !== undefined)
				rows.push({
					...shared,
					id: `${opening._id}:clauses`,
					at: opening.lastClauseAt,
					type: 'clause_opened' as const
				});
		}
		return rows.sort((a, b) => b.at - a.at);
	}
});

/** Bounded retirement of expired activity. Reads and writes also enforce expiry. */
export const expire = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		const budget = cleanupBudget(ctx);
		for (const table of ['buyerActivityReceipts', 'buyerActivityOpenings'] as const) {
			if (
				!(await budget.drain(
					table,
					ctx.db.query(table).withIndex('by_expiresAt', (q) => q.lte('expiresAt', now))
				))
			) {
				await ctx.scheduler.runAfter(0, internal.buyerActivity.expire, {});
				break;
			}
		}
		return null;
	}
});
