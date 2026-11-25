import { v, type Infer } from 'convex/values';

export const concessionStatus = v.union(
	v.literal('approved'),
	v.literal('pending'),
	v.literal('rejected')
);
export const contractConcession = v.object({
	itemId: v.id('playbookItems'),
	optionId: v.string(),
	status: concessionStatus,
	reviewedBy: v.optional(v.id('profiles')),
	reviewedAt: v.optional(v.number())
});
export const decisionAction = v.union(v.literal('approve'), v.literal('decline'));
export const workBlock = v.union(
	v.null(),
	v.literal('association-required'),
	v.literal('deal-unavailable')
);
export const contractReviewRequest = v.object({
	generation: v.number(),
	deliveryId: v.id('emailDeliveries'),
	requesterId: v.id('profiles'),
	requestedAt: v.number()
});
export const contractReviewCompletion = v.union(
	v.object({
		generation: v.number(),
		kind: v.literal('awaitingConfirmation'),
		reviewerId: v.id('profiles'),
		decidedAt: v.number()
	}),
	v.object({
		generation: v.number(),
		kind: v.literal('queued'),
		deliveryId: v.id('emailDeliveries')
	})
);
export const contractReview = v.object({
	generation: v.number(),
	request: v.optional(contractReviewRequest),
	completion: v.optional(contractReviewCompletion)
});

export type ConcessionStatus = Infer<typeof concessionStatus>;
export type ContractConcession = Infer<typeof contractConcession>;
export type DecisionAction = Infer<typeof decisionAction>;
export type WorkBlock = Infer<typeof workBlock>;
export type ContractReview = Infer<typeof contractReview>;

export function concessionSelectionMap(
	concessions: readonly ContractConcession[]
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of concessions) result[entry.itemId] = entry.optionId;
	return result;
}

export function approvedConcessionMap(
	concessions: readonly ContractConcession[]
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of concessions)
		if (entry.status === 'approved') result[entry.itemId] = entry.optionId;
	return result;
}

export function contractReadiness(
	concessions: readonly ContractConcession[],
	block: WorkBlock = null
) {
	let pendingCount = 0;
	let rejectedCount = 0;
	let approvedCount = 0;
	for (const entry of concessions) {
		if (entry.status === 'pending') pendingCount++;
		else if (entry.status === 'rejected') rejectedCount++;
		else approvedCount++;
	}
	return {
		pendingCount,
		rejectedCount,
		approvedCount,
		ready: pendingCount === 0 && rejectedCount === 0 && !block,
		workBlock: block
	};
}
