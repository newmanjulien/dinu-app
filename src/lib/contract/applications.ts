import { v, type Infer } from 'convex/values';
import type { Id } from '../../convex/_generated/dataModel';

export const reviewStatus = v.union(
	v.literal('pending'),
	v.literal('approved'),
	v.literal('rejected')
);
export const reviewDecision = v.union(v.literal('approved'), v.literal('rejected'));
export const applicationChoice = v.object({
	concessionId: v.string(),
	applicationId: v.optional(v.string())
});
export const applicationChoices = v.record(v.id('playbookItems'), applicationChoice);
export const approvalState = v.object({ applicationId: v.string(), status: reviewStatus });
export const appliedConcession = v.object({
	concessionId: v.string(),
	approval: v.optional(approvalState)
});
export const appliedConcessions = v.record(v.id('playbookItems'), appliedConcession);
export type ApplicationChoices = Infer<typeof applicationChoices>;
export type AppliedConcessions = Infer<typeof appliedConcessions>;

/** Rendering sees only concession identity, never approval or transport state. */
export function concessionSelections(
	applications: Readonly<Record<string, { concessionId: string }>>
) {
	return Object.fromEntries(
		Object.entries(applications).map(([id, value]) => [id, value.concessionId])
	) as Record<Id<'playbookItems'>, string>;
}

/** A client chooses application identity; only the server chooses its status. */
export function choicesOf(applications: AppliedConcessions): ApplicationChoices {
	return Object.fromEntries(
		Object.entries(applications).map(([id, value]) => [
			id,
			{
				concessionId: value.concessionId,
				...(value.approval ? { applicationId: value.approval.applicationId } : {})
			}
		])
	);
}

export function sameApplications(a: ApplicationChoices, b: ApplicationChoices): boolean {
	return (
		Object.keys(a).length === Object.keys(b).length &&
		Object.entries(a).every(
			([id, value]) =>
				b[id as Id<'playbookItems'>]?.concessionId === value.concessionId &&
				b[id as Id<'playbookItems'>]?.applicationId === value.applicationId
		)
	);
}

export function reviewEntries(applications: AppliedConcessions) {
	return Object.entries(applications).flatMap(([id, value]) =>
		value.approval
			? [
					[
						id as Id<'playbookItems'>,
						{ concessionId: value.concessionId, ...value.approval }
					] as const
				]
			: []
	);
}
