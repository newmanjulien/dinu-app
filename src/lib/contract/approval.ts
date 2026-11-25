import type { Id } from '../../convex/_generated/dataModel';
import type { DeepReadonly } from '../immutable';
import type { RepInstructionRecord, SourceTarget } from '../playbook/model';
import type { ConcessionStatus, ContractConcession, DecisionAction } from './changes';

export type ReviewStatus = ConcessionStatus;
export type ReviewDecision = DecisionAction;

export type ReviewTag = {
	itemId: Id<'playbookItems'>;
	optionId: string;
	description: string;
	status: ReviewStatus;
	targets: readonly SourceTarget[];
	admin: boolean;
	disabled: boolean;
	error?: string;
};

export type ReviewNavigation = { afterItemId?: string };

/** Exhaustive set of admin transitions allowed for a concession review status. */
export function availableReviewDecisions(status: ReviewStatus): readonly ReviewDecision[] {
	switch (status) {
		case 'pending':
			return ['approve', 'decline'];
		case 'approved':
			return ['decline'];
		case 'rejected':
			return ['approve'];
	}
}

/** Derive left-margin review tags synchronously from saved concessions and template Playbook items. */
export function deriveReviewTags(
	concessions: readonly ContractConcession[],
	items: DeepReadonly<RepInstructionRecord[]>,
	options: {
		admin: boolean;
		disabled?: boolean;
		errors?: ReadonlyMap<string, string>;
	}
): ReviewTag[] {
	const byId = new Map(items.map((item) => [item._id, item]));
	const tags: ReviewTag[] = [];
	for (const entry of concessions) {
		const item = byId.get(entry.itemId);
		if (!item || item.approvalPolicy.kind !== 'required') continue;
		const option = item.concessions.find((c) => c.id === entry.optionId);
		if (!option) continue;
		const targets =
			option.changes.length > 0
				? option.changes.map((change) => change.target)
				: [item.trigger.target];
		tags.push({
			itemId: entry.itemId,
			optionId: entry.optionId,
			description: option.description,
			status: entry.status,
			targets,
			admin: options.admin,
			disabled: Boolean(options.disabled),
			error: options.errors?.get(entry.itemId)
		});
	}
	return tags;
}
