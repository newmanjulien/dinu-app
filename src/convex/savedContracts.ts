/** Temporary v1 contract API. New callers use contracts; storage remains savedContracts. */
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { v, type Infer } from 'convex/values';
import { legacyChoices } from '../lib/contract/legacy-values';
import { api } from './_generated/api';
import { mutation, query } from './_generated/server';
import { selections } from './contractValidators';
import { legacyCard, legacyMetadata, legacyContractView, legacySaveResult } from './legacyViews';

export const state = query({
	args: { membershipId: v.id('memberships'), id: v.string() },
	returns: v.union(legacyMetadata, v.null()),
	handler: async (ctx, args): Promise<Infer<typeof legacyMetadata> | null> => {
		const contract = await ctx.runQuery(api.contracts.state, args);
		return contract ? legacyContractView(contract) : null;
	}
});
const browseResult = paginationResultValidator(legacyCard);
export const browse = query({
	args: {
		membershipId: v.id('memberships'),
		search: v.string(),
		paginationOpts: paginationOptsValidator
	},
	returns: browseResult,
	handler: async (ctx, args): Promise<Infer<typeof browseResult>> => {
		const result = await ctx.runQuery(api.contracts.browse, args);
		return {
			...result,
			page: result.page.map(({ buyerCompanyName, ...card }) => ({
				...card,
				companyName: buyerCompanyName
			}))
		};
	}
});
const createResult = v.union(
	v.object({ status: v.literal('created'), id: v.id('savedContracts'), contract: legacyMetadata }),
	v.object({ status: v.literal('deleted') }),
	v.object({ status: v.literal('association-required') })
);
export const create = mutation({
	args: { membershipId: v.id('memberships'), companyName: v.string(), operationId: v.string() },
	returns: createResult,
	handler: async (ctx, { companyName, ...args }): Promise<Infer<typeof createResult>> => {
		const result = await ctx.runMutation(api.contracts.create, {
			...args,
			buyerCompanyName: companyName
		});
		return result.status === 'created'
			? { ...result, contract: legacyContractView(result.contract) }
			: result;
	}
});
export const saveChoices = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		selectedConcessions: selections,
		selectionLifecycles: v.record(v.id('playbookItems'), v.string()),
		expectedRevision: v.number(),
		operationId: v.string()
	},
	returns: legacySaveResult,
	handler: async (
		ctx,
		{ selectedConcessions, selectionLifecycles, expectedRevision, ...args }
	): Promise<Infer<typeof legacySaveResult>> => {
		const result = await ctx.runMutation(api.contracts.saveChoices, {
			...args,
			choices: legacyChoices(selectedConcessions, selectionLifecycles),
			expectedEditRevision: expectedRevision
		});
		return result.status === 'deleted'
			? result
			: { ...result, state: legacyContractView(result.state) };
	}
});
export const rename = mutation({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts'), companyName: v.string() },
	returns: v.null(),
	handler: (ctx, { companyName, ...args }): Promise<null> =>
		ctx.runMutation(api.contracts.rename, { ...args, buyerCompanyName: companyName })
});
export { remove } from './contracts';
