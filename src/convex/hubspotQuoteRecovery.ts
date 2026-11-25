import { ConvexError, v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { availableCompany } from './auth';
import { installation } from './hubspotInstallation';
import { connectionToken, hubspot } from './hubspotApi';
import schema from './schema';
import { activeQuote, numericQuoteId, quotePath, quoteUrl } from './hubspotQuoteProvider';
import { quoteRunningUntil } from './hubspotQuoteValidators';

const evidence = (value: string) => {
	if (value.trim().length < 10 || value.length > 1000)
		throw new ConvexError(
			'Provide a concise operator evidence reference (10–1000 characters), without contract text or credentials.'
		);
};

export const data = internalQuery({
	args: { id: v.id('hubspotQuotePushes') },
	returns: v.object({
		push: schema.doc('hubspotQuotePushes'),
		connection: schema.doc('hubspotConnections')
	}),
	handler: async (ctx, { id }) => {
		const push = await ctx.db.get('hubspotQuotePushes', id);
		if (
			!push ||
			!(await availableCompany(ctx, push.companyId)) ||
			!['unknown', 'attention', 'verified'].includes(push.state)
		)
			throw new ConvexError('This push is not available for operator recovery.');
		const connection = await installation(ctx, push.companyId);
		if (!connection || connection.accountId !== push.destination.accountId)
			throw new ConvexError('Connect the original HubSpot account before reconciliation.');
		return { push, connection };
	}
});

/** Internal operator action: positively identify a quote before adopting its ID. Never creates. */
export const attach = internalAction({
	args: { id: v.id('hubspotQuotePushes'), quoteId: v.string(), evidence: v.string() },
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		evidence(args.evidence);
		if (!numericQuoteId(args.quoteId)) throw new ConvexError('Invalid quote ID.');
		const { push, connection } = await ctx.runQuery(internal.hubspotQuoteRecovery.data, {
			id: args.id
		});
		const live = await connectionToken(ctx, connection);
		const raw: unknown = await hubspot(
			ctx,
			live,
			`${quotePath}/${args.quoteId}?properties=hs_template_type,hs_title&associations=deals`
		);
		const properties = activeQuote(raw, args.quoteId, push.destination.dealId);
		if (
			!properties ||
			typeof properties.hs_title !== 'string' ||
			!properties.hs_title.endsWith(`— Dinu ${push.fingerprint.slice(0, 8)}`)
		)
			throw new ConvexError(
				'The quote does not positively identify this contract handoff. No recovery was committed.'
			);
		await ctx.runMutation(internal.hubspotQuoteRecovery.resolve, {
			...args,
			disposition: 'identified'
		});
		return null;
	}
});

/** An archived record is positive deletion evidence; a 404 or missing search result is not. */
export const replaceArchived = internalAction({
	args: { id: v.id('hubspotQuotePushes'), evidence: v.string() },
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		evidence(args.evidence);
		const { push, connection } = await ctx.runQuery(internal.hubspotQuoteRecovery.data, {
			id: args.id
		});
		if (!push.quoteId) throw new ConvexError('This push has no known quote.');
		const raw: unknown = await hubspot(
			ctx,
			await connectionToken(ctx, connection),
			`${quotePath}/${push.quoteId}?archived=true`
		);
		if (
			!raw ||
			typeof raw !== 'object' ||
			(raw as Record<string, unknown>).archived !== true ||
			String((raw as Record<string, unknown>).id) !== push.quoteId
		)
			throw new ConvexError('HubSpot has not confirmed that this quote is archived.');
		await ctx.runMutation(internal.hubspotQuoteRecovery.resolve, {
			...args,
			quoteId: push.quoteId,
			disposition: 'archived'
		});
		return null;
	}
});

/** Operator-only. Search absence is never evidence that a request was not created. */
export const resolve = internalMutation({
	args: {
		id: v.id('hubspotQuotePushes'),
		quoteId: v.optional(v.string()),
		disposition: v.union(
			v.literal('identified'),
			v.literal('confirmed-not-created'),
			v.literal('archived')
		),
		evidence: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		evidence(args.evidence);
		if (
			(args.disposition !== 'confirmed-not-created') !== Boolean(args.quoteId) ||
			(args.quoteId && !numericQuoteId(args.quoteId))
		)
			throw new ConvexError('Invalid operator disposition.');
		const row = await ctx.db.get('hubspotQuotePushes', args.id);
		if (
			!row ||
			!(
				args.disposition === 'archived' ? ['verified', 'attention'] : ['unknown', 'attention']
			).includes(row.state) ||
			quoteRunningUntil(row) > Date.now()
		)
			throw new ConvexError('Wait for the push to settle before operator recovery.');
		if (
			!(await availableCompany(ctx, row.companyId)) ||
			!(await ctx.db.get('savedContracts', row.contractId))
		)
			throw new ConvexError('This contract is unavailable.');
		if (args.quoteId && row.quoteId && args.quoteId !== row.quoteId)
			throw new ConvexError('This push already has a different quote identity.');
		if (!args.quoteId && row.quoteId)
			throw new ConvexError(
				'A known quote cannot be cleared without a separate verified deletion procedure.'
			);
		const now = Date.now();
		if (args.disposition === 'archived') {
			if (args.quoteId !== row.quoteId)
				throw new ConvexError('The original quote identity is required.');
			await ctx.db.patch('hubspotQuotePushes', row._id, {
				state: 'retired',
				previousQuoteId: row.quoteId,
				quoteId: undefined,
				url: undefined,
				recoveryEvidence: args.evidence,
				claim: undefined,
				workId: undefined,
				leaseUntil: undefined,
				dueAt: undefined,
				updatedAt: now,
				settledAt: now,
				message:
					'HubSpot confirmed the original quote is archived. Push again to create a replacement draft.'
			});
			return null;
		}
		const verify = Boolean(args.quoteId && row.fileId);
		const nextState = args.quoteId ? (verify ? 'verifying' : 'attention') : 'rejected';
		await ctx.db.patch('hubspotQuotePushes', row._id, {
			state: nextState,
			...(args.quoteId
				? {
						quoteId: args.quoteId,
						url: quoteUrl(row.destination.accountId, args.quoteId)
					}
				: {}),
			recoveryEvidence: args.evidence,
			claim: undefined,
			workId: undefined,
			leaseUntil: undefined,
			readAttempts: 0,
			dueAt: verify ? now : undefined,
			updatedAt: now,
			...(nextState === 'rejected' ? { settledAt: now } : {}),
			message: args.quoteId
				? 'An operator identified the quote. Review it in HubSpot while the transfer is checked.'
				: 'An operator confirmed the original request was not created. You can push again.'
		});
		if (verify) await ctx.scheduler.runAfter(0, internal.hubspotQuotes.pump, {});
		return null;
	}
});
