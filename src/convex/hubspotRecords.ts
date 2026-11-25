import type { Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { actorOf } from './operationReceipts';
import { hubspotKind } from './hubspotValidators';
import type { ContractHubspotLink } from './contractState';
import { activeDestination } from './hubspotInstallation';

export async function prepareActivity(
	ctx: QueryCtx,
	contract: {
		root: Pick<Doc<'savedContracts'>, '_id' | 'companyId' | 'title'>;
		hubspot?: ContractHubspotLink;
	},
	actor: ReturnType<typeof actorOf>,
	key: string,
	kind: Infer<typeof hubspotKind>,
	detail = '',
	occurredAt = Date.now(),
	attemptId?: Doc<'wordExports'>['_id']
) {
	if (
		!contract.hubspot ||
		!(await activeDestination(ctx, contract.root.companyId, contract.hubspot))
	)
		return { active: false, row: null };
	if (
		await ctx.db
			.query('hubspotEvents')
			.withIndex('by_key', (q) => q.eq('key', key))
			.unique()
	)
		return { active: true, row: null };
	const { availability: _availability, ...destination } = contract.hubspot;
	// Rendered details are bounded independently of immutable reference chunks/receipts.
	const bounded = boundActivityDetail(detail);
	const row: Omit<Doc<'hubspotEvents'>, '_id' | '_creationTime'> = {
		companyId: contract.root.companyId,
		contractId: contract.root._id,
		destination,
		key,
		kind,
		title: contract.root.title,
		actor,
		occurredAt,
		detail: bounded,
		attemptId,
		status:
			contract.hubspot.availability === 'unavailable' ||
			(attemptId && (await linkBlocked(ctx, contract.root._id, contract.hubspot.generation)))
				? 'paused'
				: 'pending',
		dueAt: Date.now(),
		tries: 0
	};
	return { active: true, row };
}
type ActivityArguments =
	Parameters<typeof prepareActivity> extends [unknown, ...infer Rest] ? Rest : never;
export async function activity(ctx: MutationCtx, ...args: ActivityArguments) {
	const prepared = await prepareActivity(ctx, ...args);
	if (prepared.row) await ctx.db.insert('hubspotEvents', prepared.row);
	return prepared.active;
}
export function linkBlocked(
	ctx: QueryCtx,
	contractId: Doc<'savedContracts'>['_id'],
	generation: number
) {
	return ctx.db
		.query('hubspotLinkBlocks')
		.withIndex('by_contractId_and_generation', (q) =>
			q.eq('contractId', contractId).eq('generation', generation)
		)
		.unique();
}
export async function blockLink(
	ctx: MutationCtx,
	companyId: Doc<'company'>['_id'],
	contractId: Doc<'savedContracts'>['_id'],
	generation: number
) {
	if (!(await linkBlocked(ctx, contractId, generation)))
		await ctx.db.insert('hubspotLinkBlocks', { companyId, contractId, generation });
}

export function boundActivityDetail(detail: string) {
	let bounded = detail;
	if (new TextEncoder().encode(bounded).length > 48 * 1024) {
		try {
			const parsed = JSON.parse(detail);
			bounded = JSON.stringify({
				...parsed,
				description:
					typeof parsed.description === 'string' ? parsed.description.slice(0, 8000) : undefined,
				abbreviated: true
			});
		} catch {
			bounded = detail.slice(0, 8000);
		}
	}
	return bounded;
}
