import { ConvexError, v } from 'convex/values';
import { pool } from './hubspotDelivery';
import type { WorkId } from '@convex-dev/workpool';
import { deliveryFacts } from './hubspotDeliveryPolicy';
import { internalMutation } from './_generated/server';
/** Operator-only. Record evidence before permitting any formerly ambiguous write to be sent again. */
export const recover = internalMutation({
	args: {
		id: v.id('hubspotEvents'),
		disposition: v.union(v.literal('reconcile'), v.literal('confirmed-not-sent')),
		evidence: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if (!args.evidence.trim() || args.evidence.length > 2000)
			throw new ConvexError('Provide a concise evidence reference.');
		const event = await ctx.db.get('hubspotEvents', args.id);
		if (
			!event ||
			!['attention', 'uncertain', 'blocked', 'paused'].includes(event.status) ||
			(event.leaseUntil ?? 0) + 30_000 > Date.now()
		)
			throw new ConvexError('This activity is not ready for operator recovery.');
		if (args.disposition === 'reconcile' && !event.dispatch)
			throw new ConvexError('There is no ambiguous write to reconcile.');
		const facts = await deliveryFacts(ctx, event);
		if (args.disposition === 'confirmed-not-sent' && (!facts.linkValid || !facts.accountValid))
			throw new ConvexError('The original live deal link is required for a fresh write.');
		if (event.workId) await pool.cancel(ctx, event.workId as WorkId);
		await ctx.db.patch('hubspotEvents', event._id, {
			status: args.disposition === 'reconcile' ? 'uncertain' : 'pending',
			dueAt: Date.now(),
			workId: undefined,
			execution: undefined,
			operatorObservation: args.disposition === 'reconcile',
			claim: undefined,
			diagnostic: `Operator ${args.disposition}: ${args.evidence}`,
			...(args.disposition === 'confirmed-not-sent'
				? {
						dispatch: undefined,
						dispatchId: undefined,
						dispatchedAt: undefined,
						observation: undefined
					}
				: {})
		});
		return null;
	}
});
