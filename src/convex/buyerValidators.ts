import { v } from 'convex/values';
import { releasedSelections } from '../lib/contract/released-selections';
import { sourceBlock } from '../lib/document/source-validators';
import { trigger, contractChange } from '../lib/playbook/validators';

export const buyerLink = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	creatorId: v.id('profiles'),
	token: v.string(),
	createdAt: v.number()
});
export const buyerState = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	templateVersionId: v.id('templateVersions'),
	title: v.string(),
	selections: releasedSelections,
	buyerRevision: v.number()
});
export const buyerItem = v.object({
	itemId: v.string(),
	trigger,
	concessions: v.array(v.object({ id: v.string(), changes: v.array(contractChange) }))
});
export const buyerExplanation = v.object({
	itemId: v.id('playbookItems'),
	trigger,
	explanation: v.string()
});
export const buyerContent = v.object({
	title: v.string(),
	buyerRevision: v.number(),
	blocks: v.array(sourceBlock),
	templateItems: v.array(buyerItem),
	explanations: v.array(buyerExplanation),
	items: v.array(buyerItem),
	selections: releasedSelections
});
export const linkSummary = v.object({
	id: v.id('buyerLinks'),
	token: v.string(),
	createdAt: v.number()
});
export const linkPreparation = v.union(
	v.object({ kind: v.literal('saved') }),
	v.object({ kind: v.literal('flushed'), expectedEditRevision: v.number() })
);
export const publicStatus = v.union(
	v.object({ kind: v.literal('unavailable') }),
	v.object({ kind: v.literal('current'), title: v.string(), buyerRevision: v.number() })
);
