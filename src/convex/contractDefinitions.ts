import { v } from 'convex/values';
import { query } from './_generated/server';
import { seller } from './buyerLinks';
import { contractReader } from './contractReader';
import { contractItem } from './contractItemValidators';
export const selected = query({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts') },
	returns: v.array(contractItem),
	handler: async (ctx, args) => {
		const { contract } = await seller(ctx, args);
		const local = Object.fromEntries(
			Object.entries(contract.applications)
				.filter(([id]) => ctx.db.normalizeId('contractConcessions', id))
				.map(([id, app]) => [id, app.concessionId])
		);
		if (!Object.keys(local).length) return [];
		return (await contractReader(ctx, contract)).selectedItems(local);
	}
});
