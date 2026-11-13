import { v } from 'convex/values';
import { contractRenderTransport } from './contractValidators';
import { sourceTarget } from '../lib/document/source-validators';
import { trigger } from '../lib/playbook/validators';
import { readiness } from '../lib/contract/changes';

/** A small derived pointer, revoked synchronously by logical deletion. */
export const buyerCurrentView = v.object({
	documentId: v.id('contractDocuments'),
	documentRevision: v.number(),
	documentFingerprint: v.string(),
	title: v.string(),
	templateVersionId: v.id('templateVersions'),
	buyerName: v.union(v.string(), v.null()),
	displayIdentity: v.string()
});
export const buyerLink = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	creatorId: v.id('profiles'),
	token: v.string(),
	createdAt: v.number(),
	currentView: v.union(buyerCurrentView, v.null())
});
export const buyerExplanation = v.object({
	itemId: v.id('playbookItems'),
	trigger,
	explanation: v.string()
});
export const currentBuyerDocument = v.object({
	title: v.string(),
	document: contractRenderTransport,
	contentIdentity: v.id('contractDocuments'),
	contentRevision: v.number(),
	displayIdentity: v.string(),
	explanations: v.array(buyerExplanation),
	annotationGroups: v.array(v.array(v.object({ target: sourceTarget })))
});
export const linkSummary = v.object({
	id: v.id('buyerLinks'),
	token: v.string(),
	createdAt: v.number()
});
export const linkPreparation = v.union(
	v.object({ kind: v.literal('existing') }),
	v.object({
		kind: v.literal('prepared'),
		expectedState: readiness.fields.expectation,
		operationId: v.string()
	})
);
export const publicStatus = v.union(
	v.object({ kind: v.literal('unavailable') }),
	v.object({
		kind: v.literal('current'),
		title: v.string(),
		companyName: v.string(),
		buyerName: v.union(v.string(), v.null())
	})
);
