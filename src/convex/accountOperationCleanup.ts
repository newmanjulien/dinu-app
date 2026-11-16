import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { cleanupBudget } from './cleanup';
import { retirePendingOperation } from './contractRetention';
import { retireOutputPreparation } from './outputReservations';

/** Account deletion retires only that actor's private work. Company evidence, remote
 * outcomes, canonical fences and full/compact history retain their original owners. */
export async function retireAccountOperations(
	ctx: MutationCtx,
	profileId: Id<'profiles'>,
	budget: ReturnType<typeof cleanupBudget>
) {
	if (await budget.exhausted()) return false;
	const reason = 'This account was deleted.';
	const pending = await ctx.db
		.query('operationReceipts')
		.withIndex('by_actor_profileId_and_state', (q) =>
			q.eq('actor.profileId', profileId).eq('state', 'preparing')
		)
		.first();
	if (pending) {
		await retirePendingOperation(ctx, pending, reason);
		return false;
	}
	const email = await ctx.db
		.query('operationReceipts')
		.withIndex('by_actor_profileId_and_emailPreparation_dueAt', (q) =>
			q.eq('actor.profileId', profileId).gte('emailPreparation.dueAt', 0)
		)
		.first();
	if (email) {
		await retirePendingOperation(ctx, email, reason);
		return false;
	}
	for (const purpose of ['reservation', 'release'] as const) {
		const output = await ctx.db
			.query('contractOutputs')
			.withIndex('by_actor_profileId_and_outputPreparation_purpose', (q) =>
				q.eq('actor.profileId', profileId).eq('outputPreparation.purpose', purpose)
			)
			.first();
		if (!output) continue;
		if (output.format !== 'full') throw new Error('Compact output has private work.');
		await retireOutputPreparation(ctx, output, reason);
		return false;
	}
	return true;
}
