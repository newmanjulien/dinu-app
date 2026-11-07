import { ConvexError, type Infer } from 'convex/values';
import {
	reviewEntries,
	type ApplicationChoices,
	type AppliedConcessions
} from '../lib/contract/applications';
import { MAX_APPLICATION_ID_LENGTH } from '../lib/contract/selection-limits';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import type { storedDecision } from './contractValidators';
import type { Role } from './permissions';
import type { historicalItem } from './playbookValidators';

/** Each selected concession owns its current review application, independent of audit history. */
export function reviewsForSelections(
	items: Infer<typeof historicalItem>[],
	choices: ApplicationChoices,
	previous: AppliedConcessions,
	reviewerRole: Role
) {
	const applications: AppliedConcessions = {};
	const autoApprovedItemIds: Id<'playbookItems'>[] = [];
	for (const item of items) {
		const choice = choices[item._id];
		if (item.approvalPolicy.kind === 'none') {
			if (choice.applicationId !== undefined)
				throw new ConvexError('Invalid concession application.');
			applications[item._id] = { concessionId: choice.concessionId };
			continue;
		}
		const applicationId = choice.applicationId;
		if (!applicationId?.trim() || applicationId.length > MAX_APPLICATION_ID_LENGTH)
			throw new ConvexError('Invalid concession application.');
		const prior = previous[item._id];
		const unchanged =
			prior?.concessionId === choice.concessionId &&
			prior.approval?.applicationId === applicationId;
		applications[item._id] = unchanged
			? prior
			: {
					concessionId: choice.concessionId,
					approval: { applicationId, status: reviewerRole === 'admin' ? 'approved' : 'pending' }
				};
		if (!unchanged && reviewerRole === 'admin') autoApprovedItemIds.push(item._id);
	}
	return { applications, autoApprovedItemIds };
}

/** Both explicit decisions and admin application saves write complete immutable receipts. */
export function recordDecision(
	ctx: MutationCtx,
	contract: Pick<Doc<'savedContracts'>, '_id' | 'companyId'>,
	reviewer: Pick<Doc<'profiles'>, '_id' | 'name' | 'email'>,
	decision: Omit<
		Infer<typeof storedDecision>,
		'companyId' | 'contractId' | 'adminId' | 'adminName' | 'adminEmail'
	>
) {
	return ctx.db.insert('concessionDecisions', {
		...decision,
		companyId: contract.companyId,
		contractId: contract._id,
		adminId: reviewer._id,
		adminName: reviewer.name,
		adminEmail: reviewer.email
	});
}

export function completedReview(contract: Pick<Doc<'savedContracts'>, 'applications'>) {
	const reviews = reviewEntries(contract.applications);
	return reviews.length > 0 && reviews.every(([, review]) => review.status !== 'pending');
}

/** Review supplies current business context; delivery owns when that context is frozen. */
export function decisionSelections(contract: Pick<Doc<'savedContracts'>, 'applications'>) {
	return reviewEntries(contract.applications)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, review]) => ({
			itemId: id as Id<'playbookItems'>,
			concessionId: review.concessionId,
			approval: { applicationId: review.applicationId, status: review.status }
		}));
}
