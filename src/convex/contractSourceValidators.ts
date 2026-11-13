import { v, type Infer } from 'convex/values';

/** Admission freshness is deliberately distinct from canonical output identity. */
export const sourceExpectation = v.object({
	stateRevision: v.number(),
	documentId: v.id('contractDocuments'),
	documentRevision: v.number(),
	title: v.string(),
	templateVersionId: v.id('templateVersions')
});
export type ExpectedContractSource = Infer<typeof sourceExpectation>;
