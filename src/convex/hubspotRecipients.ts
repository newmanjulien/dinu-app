import { v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import { action } from './_generated/server';
import { connectionToken, HubSpotError, resolveRecipient } from './hubspotApi';
import { hubspotDestination } from './hubspotValidators';

const target = hubspotDestination.extend({ installedAt: v.number() });
const result = v.object({
	target: v.union(target, v.null()),
	outcome: v.union(
		v.literal('resolved'),
		v.literal('empty'),
		v.literal('missing-capability'),
		v.literal('indeterminate'),
		v.literal('obsolete')
	),
	company: v.union(v.object({ companyId: v.string(), name: v.string() }), v.null()),
	retryAfter: v.number()
});

/** Company naming is a display enhancement, independent of deal availability and contract writes. */
export const resolve = action({
	args: { membershipId: v.id('memberships'), contractId: v.id('savedContracts') },
	returns: result,
	handler: async (ctx, args): Promise<Infer<typeof result>> => {
		const initial = await ctx.runQuery(internal.hubspotDeals.checkTarget, args);
		const obsolete = { target: null, outcome: 'obsolete', company: null, retryAfter: 0 } as const;
		if (!initial || initial.link.availability !== 'available') return obsolete;
		const identity = {
			connectionId: initial.link.connectionId,
			accountId: initial.link.accountId,
			dealId: initial.link.dealId,
			generation: initial.link.generation,
			installedAt: initial.connection.installedAt
		};
		if (!initial.connection.scopes.includes('crm.objects.companies.read'))
			return { target: identity, outcome: 'missing-capability', company: null, retryAfter: 0 };
		let outcome: Infer<typeof result>['outcome'];
		let company: Infer<typeof result>['company'] = null;
		let retryAfter = 0;
		try {
			const connection = await connectionToken(ctx, initial.connection);
			company = await resolveRecipient(ctx, connection, initial.link.dealId);
			outcome = company ? 'resolved' : 'empty';
		} catch (error) {
			outcome =
				error instanceof HubSpotError && error.status === 404 && error.stage === 'attempted'
					? 'empty'
					: error instanceof HubSpotError && error.status === 403
						? 'missing-capability'
						: 'indeterminate';
			retryAfter =
				outcome === 'indeterminate'
					? Math.min(
							300_000,
							Math.max(2000, error instanceof HubSpotError ? error.retryAfter : 15_000)
						)
					: 0;
		}
		// Recheck membership/ownership and installation after IO, without treating token refresh as relink.
		const current = await ctx.runQuery(internal.hubspotDeals.checkTarget, args);
		if (
			!current ||
			current.link.availability !== 'available' ||
			current.link.connectionId !== identity.connectionId ||
			current.link.accountId !== identity.accountId ||
			current.link.dealId !== identity.dealId ||
			current.link.generation !== identity.generation ||
			current.connection.installedAt !== identity.installedAt
		)
			return obsolete;
		return { target: identity, outcome, company, retryAfter };
	}
});
