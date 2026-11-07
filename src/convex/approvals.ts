/** Temporary v1 review API. New callers use contractApprovals. */
import { v, type Infer } from 'convex/values';
import { reviewDecision } from '../lib/contract/applications';
import { api } from './_generated/api';
import { mutation, query } from './_generated/server';
import { approvalRequest } from './contractValidators';
import { legacyApprovalSelection } from './legacyViews';

const legacyRequest = approvalRequest
	.omit('buyerCompanyName', 'selectedConcessions')
	.extend({ companyName: v.string(), selectedConcessions: v.array(legacyApprovalSelection) });
function project(request: Infer<typeof approvalRequest>): Infer<typeof legacyRequest> {
	const { buyerCompanyName, selectedConcessions, ...state } = request;
	return {
		...state,
		companyName: buyerCompanyName,
		selectedConcessions: selectedConcessions.map(({ approval, ...selection }) => ({
			...selection,
			...(approval ? { lifecycle: approval.applicationId, reviewStatus: approval.status } : {})
		}))
	};
}
export const latest = query({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts') },
	returns: v.union(legacyRequest, v.null()),
	handler: async (ctx, args): Promise<Infer<typeof legacyRequest> | null> => {
		const request = await ctx.runQuery(api.contractApprovals.latest, args);
		return request ? project(request) : null;
	}
});
export const request = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		expectedRevision: v.number()
	},
	returns: legacyRequest,
	handler: async (ctx, { expectedRevision, ...args }): Promise<Infer<typeof legacyRequest>> =>
		project(
			await ctx.runMutation(api.contractApprovals.request, {
				...args,
				expectedEditRevision: expectedRevision
			})
		)
});
export const decide = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		itemId: v.id('playbookItems'),
		concessionId: v.string(),
		lifecycle: v.string(),
		status: reviewDecision,
		operationId: v.string()
	},
	returns: v.null(),
	handler: (ctx, { lifecycle, ...args }): Promise<null> =>
		ctx.runMutation(api.contractApprovals.decide, { ...args, applicationId: lifecycle })
});
export { confirmCompletion, resetCompletion } from './contractApprovals';
